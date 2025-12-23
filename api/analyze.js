import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- DIMENSION PARSER ---
function getDimensions(buffer) {
    try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) { 
            const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
            const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
            return { width, height, type: 'png' };
        }
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) { 
            let i = 2;
            while (i < buffer.length) {
                if (buffer[i] !== 0xFF) return null; 
                while (buffer[i] === 0xFF) i++;
                const marker = buffer[i];
                i++;
                const len = (buffer[i] << 8) | buffer[i + 1];
                if (marker >= 0xC0 && marker <= 0xC3) {
                    const height = (buffer[i + 5] << 8) | buffer[i + 6];
                    const width = (buffer[i + 7] << 8) | buffer[i + 8];
                    return { width, height, type: 'jpg' };
                }
                i += len;
            }
        }
    } catch (e) { return null; }
    return null;
}

// --- GENERATOR ID ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 5;
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
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
        version: "osint-final-fix-v26",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- PREP: FETCH & FORMAT ---
        let base64Payload = null;
        if (!isAudio) {
            try {
                // Force High Quality from Cloudinary to ensure Lens sees details
                let fetchUrl = mediaUrl;
                if (mediaUrl.includes('cloudinary')) {
                    fetchUrl = mediaUrl.replace('/upload/', '/upload/q_100/');
                }

                const imgRes = await fetch(fetchUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
                // Get Metadata
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                let mime = 'jpeg'; // Default
                
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height} (${dims.type})`);
                    mime = dims.type === 'png' ? 'png' : 'jpeg';
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

                // FORMAT WITH PREFIX (The Critical Fix)
                if (buffer.length < 5000000) { // 5MB limit
                    const rawBase64 = buffer.toString('base64');
                    // Add the Data URI scheme
                    base64Payload = `data:image/${mime};base64,${rawBase64}`;
                    intel.debug.push(`Prepared Data URI (${Math.round(base64Payload.length/1024)}KB)`);
                }

            } catch (e) { intel.debug.push(`Prep Failed: ${e.message}`); }
        }

        if (apiKey && !isAudio && base64Payload) {
            let rawMatches = [];

            // --- ATTEMPT 1: PREFIXED BASE64 ---
            try {
                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ image: base64Payload })
                });
                const lData = await lRes.json();
                
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Data-URI";
                else intel.debug.push("Attempt 1 (Data-URI) returned 0 matches");
            } catch (e) { intel.debug.push("Attempt 1 Error"); }

            // --- ATTEMPT 2: RAW BASE64 (Fallback) ---
            if (rawMatches.length === 0) {
                 try {
                    // Try removing the prefix just in case
                    const raw = base64Payload.split(',')[1];
                    const lRes = await fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ image: raw })
                    });
                    const lData = await lRes.json();
                    if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                    if (rawMatches.length > 0) intel.method = "Visual Raw-B64";
                } catch (e) {}
            }

            // --- PROCESSING ---
            const cleanMatches = rawMatches.filter(m => 
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

        // --- FINAL VERDICT ---
        if (intel.totalMatches === 0) {
            const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`;
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "View Results Manually",
                url: lensUrl,
                posted_time: "API Failed. Use this link."
            });
        }

        return res.status(200).json({
            service: "osint-final-fix-v26",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
