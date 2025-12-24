import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- GENERATOR ID (Strict) ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 15;
    
    // SD 1.5
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    
    // SD 2.0 / 2.1 / Midjourney v4
    if (is(w, 768) && is(h, 768)) return 'Stable Diffusion v2.1';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4';
    
    // SDXL / Midjourney v5+
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5+';
    if ((is(w, 1216) && is(h, 832)) || (is(w, 832) && is(h, 1216))) return 'SDXL (Cinematic)';
    
    // The specific "769" artifact
    if ((is(w, 769) && is(h, 1000)) || (is(w, 768) && is(h, 1000))) return 'SDXL (Portrait)';
    if ((is(w, 1000) && is(h, 769)) || (is(w, 1000) && is(h, 768))) return 'SDXL (Landscape)';

    return "Unknown";
}

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
        version: "osint-purist-v38",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        
        // --- STEP 1: DOWNLOAD & STANDARDIZE ---
        let base64Payload = null;

        if (!isAudio) {
            try {
                // 1. Fetch ORIGINAL for generator ID (dimensions matter)
                const originalRes = await fetch(mediaUrl);
                const originalBuffer = await originalRes.arrayBuffer();
                const dims = getDimensions(new Uint8Array(originalBuffer));
                
                if (dims) {
                    intel.debug.push(`Original Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Match)`;
                }

                // 2. Fetch RESIZED (512px) for API Payload
                // This is the "Standard Unit" for AI visual search. It's fast and readable.
                let searchUrl = mediaUrl;
                if (mediaUrl.includes('cloudinary')) {
                    searchUrl = mediaUrl.replace('/upload/', '/upload/w_512,c_fit,q_auto/');
                }
                
                const resizedRes = await fetch(searchUrl);
                const resizedBuffer = Buffer.from(await resizedRes.arrayBuffer());
                
                base64Payload = resizedBuffer.toString('base64');
                intel.debug.push(`Standardized Payload: ${Math.round(base64Payload.length/1024)}KB`);

            } catch (e) { intel.debug.push(`Prep Error: ${e.message}`); }
        }

        if (apiKey && !isAudio && base64Payload) {
            let rawMatches = [];

            // --- STRATEGY: PURE VISUAL SEARCH ---
            try {
                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ image: base64Payload })
                });
                const lData = await lRes.json();
                
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Fingerprint";
            } catch (e) { intel.debug.push("Visual Search Error"); }

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

            if (cleanMatches.length > 0 && intel.ai_generator_name === "Unknown") {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- FINAL FALLBACK (Manual Links Only - No Fake Data) ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "No Public Index - Click to Verify",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Image is likely unique or private"
            });
            
            // Adding Yandex as it is often better for deep image search
            intel.matches.push({
                source_name: "Yandex Images",
                title: "Deep Search (Yandex)",
                url: `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Alternative Engine"
            });
        }

        return res.status(200).json({
            service: "osint-purist-v38",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
