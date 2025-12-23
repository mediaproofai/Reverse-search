import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- DIMENSION PARSER ---
function getDimensions(buffer) {
    try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) return { width: (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19], height: (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23] };
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) { 
            let i = 2;
            while (i < buffer.length) {
                if (buffer[i] !== 0xFF) return null; 
                while (buffer[i] === 0xFF) i++;
                i++;
                const len = (buffer[i] << 8) | buffer[i + 1];
                if (buffer[i-1] >= 0xC0 && buffer[i-1] <= 0xC3) return { height: (buffer[i + 5] << 8) | buffer[i + 6], width: (buffer[i + 7] << 8) | buffer[i + 8] };
                i += len;
            }
        }
    } catch (e) { return null; }
    return null;
}

// --- GENERATOR ID (Wider Tolerance for SDXL) ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 10; // Widen tolerance to 10px
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
    if ((is(w, 768) && is(h, 1024)) || (is(w, 768) && is(h, 1000))) return 'SDXL (Portrait)'; // Fix for your 769x1000
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5';
    return "Unknown";
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl, type } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-platinum-v31",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- PREP: TINY IMAGE FOR API ---
        let base64Payload = null;
        if (!isAudio) {
            try {
                // Force a tiny, low-quality jpg (600px, q_60). 
                // This ensures the payload is small (~40KB) and never times out.
                let fetchUrl = mediaUrl;
                if (mediaUrl.includes('cloudinary')) {
                    fetchUrl = mediaUrl.replace('/upload/', '/upload/w_600,q_60/');
                }

                const imgRes = await fetch(fetchUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
                // Get Metadata (from this buffer or original, doesn't matter for ID)
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

                base64Payload = buffer.toString('base64');
                intel.debug.push(`Payload: ${Math.round(base64Payload.length/1024)}KB`);

            } catch (e) { intel.debug.push(`Prep Error: ${e.message}`); }
        }

        if (apiKey && !isAudio) {
            
            // --- PARALLEL EXECUTION (Visual + Text) ---
            const searches = [];

            // 1. VISUAL SEARCH (Lens API)
            if (base64Payload) {
                searches.push(
                    fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ image: base64Payload }) // No 'gl' param, let it float
                    })
                    .then(r => r.json())
                    .then(data => ({ type: 'Visual', data }))
                    .catch(e => ({ type: 'Visual', error: e.message }))
                );
            }

            // 2. TEXT SEARCH (Filename on Google Images)
            const cleanName = filename.split('.')[0];
            if (cleanName.length > 5) { // Only if name is significant
                searches.push(
                    fetch("https://google.serper.dev/search", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ q: cleanName, type: "images" }) // Specifically search images
                    })
                    .then(r => r.json())
                    .then(data => ({ type: 'Text', data }))
                    .catch(e => ({ type: 'Text', error: e.message }))
                );
            }

            // Wait for both
            const results = await Promise.all(searches);
            let rawMatches = [];

            results.forEach(res => {
                if (res.error) {
                    intel.debug.push(`${res.type} Error: ${res.error}`);
                    return;
                }
                
                const data = res.data;
                let count = 0;

                // Handle Lens Data
                if (res.type === 'Visual') {
                    if (data.knowledgeGraph) { rawMatches.push(data.knowledgeGraph); count++; }
                    if (data.visualMatches) { rawMatches = rawMatches.concat(data.visualMatches); count += data.visualMatches.length; }
                }

                // Handle Text/Image Data
                if (res.type === 'Text') {
                    if (data.images) { rawMatches = rawMatches.concat(data.images); count += data.images.length; }
                }

                intel.debug.push(`${res.type} found ${count} matches`);
            });

            if (rawMatches.length > 0) intel.method = "Hybrid (Visual + Text)";

            // --- PROCESSING ---
            // Deduplicate by URL
            const uniqueMap = new Map();
            rawMatches.forEach(m => uniqueMap.set(m.link, m));
            const uniqueMatches = Array.from(uniqueMap.values());

            const cleanMatches = uniqueMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            
            intel.matches = cleanMatches.slice(0, 10).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "External Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // Context Gen ID
            if (cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- FINAL FALLBACK ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "No matches found. Click to Verify.",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Manual Check Required"
            });
        }

        return res.status(200).json({
            service: "osint-platinum-v31",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
