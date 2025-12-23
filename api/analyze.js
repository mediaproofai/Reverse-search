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

// --- GENERATOR ID ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 10;
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
        version: "osint-multi-engine-v36",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- STEP 1: PREP & DOWNLOAD ---
        let base64Payload = null;
        if (!isAudio) {
            try {
                // Use optimized Cloudinary URL for speed/reliability
                let fetchUrl = mediaUrl;
                if (mediaUrl.includes('cloudinary')) {
                    fetchUrl = mediaUrl.replace('/upload/', '/upload/w_1000,q_auto/');
                }

                const imgRes = await fetch(fetchUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
                // Get Metadata
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

                // Convert to Base64 (Standard, no prefix, max 1MB safe zone)
                if (buffer.length < 2000000) {
                    base64Payload = buffer.toString('base64');
                } else {
                    intel.debug.push("Image too large for API, using URL fallback");
                }

            } catch (e) { intel.debug.push(`Prep Error: ${e.message}`); }
        }

        if (apiKey && !isAudio) {
            let rawMatches = [];

            // --- STRATEGY A: BASE64 VISUAL SEARCH ---
            if (base64Payload) {
                try {
                    const lRes = await fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ image: base64Payload })
                    });
                    const lData = await lRes.json();
                    if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                    if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                    
                    if (rawMatches.length > 0) intel.method = "Visual Search (Base64)";
                } catch (e) { intel.debug.push("Visual API Error"); }
            }

            // --- STRATEGY B: FILENAME TEXT SEARCH ---
            const cleanName = filename.split('.')[0];
            if (rawMatches.length === 0 && cleanName.length > 4) {
                try {
                    const sRes = await fetch("https://google.serper.dev/search", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ q: cleanName })
                    });
                    const sData = await sRes.json();
                    if (sData.organic) rawMatches = rawMatches.concat(sData.organic);
                    if (sData.images) rawMatches = rawMatches.concat(sData.images);
                    
                    if (rawMatches.length > 0) intel.method = "Filename Trace";
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

            if (cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- FINAL SAFETY NET: MULTI-ENGINE MANUAL LINKS ---
        // If automation fails, we give the user the keys to the kingdom.
        if (intel.totalMatches === 0) {
            const encodedUrl = encodeURIComponent(mediaUrl);
            
            intel.matches = [
                {
                    source_name: "Google Lens",
                    title: "Manual Verify (Google)",
                    url: `https://lens.google.com/uploadbyurl?url=${encodedUrl}`,
                    posted_time: "Primary Engine"
                },
                {
                    source_name: "Yandex Images",
                    title: "Manual Verify (Yandex - Best for AI)",
                    url: `https://yandex.com/images/search?rpt=imageview&url=${encodedUrl}`,
                    posted_time: "Deep Web Engine"
                },
                {
                    source_name: "Bing Visual",
                    title: "Manual Verify (Bing)",
                    url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIHMP&q=imgurl:${encodedUrl}`,
                    posted_time: "Alternative Engine"
                }
            ];
            intel.method = "Manual Multi-Engine Fallback";
        }

        return res.status(200).json({
            service: "osint-multi-engine-v36",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
