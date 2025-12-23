import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- GENERATOR ID (Enhanced Tolerance) ---
function identifyGeneratorByRes(w, h) {
    // Widen tolerance to 10px to catch cropping/rounding (e.g., 769px)
    const is = (val, target) => Math.abs(val - target) <= 10;
    
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
    if ((is(w, 768) && is(h, 512)) || (is(w, 512) && is(h, 768))) return 'Stable Diffusion (Landscape/Portrait)';
    
    // SDXL often uses 1024x1024 or near variations
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5';
    if ((is(w, 1216) && is(h, 832)) || (is(w, 832) && is(h, 1216))) return 'SDXL (Cinematic)';
    
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
        version: "osint-titan-v32",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);

        // --- STEP 1: PREP ---
        let searchUrl = mediaUrl;
        
        if (!isAudio) {
            try {
                // 1. Optimize Cloudinary URL for Google Bot
                // We use 'w_1000' (good quality) and 'q_auto' (optimized compression)
                if (mediaUrl.includes('cloudinary')) {
                    searchUrl = mediaUrl.replace('/upload/', '/upload/w_1000,q_auto/');
                    intel.debug.push("Optimized Cloudinary URL");
                }

                // 2. Fetch for Dims (Internal Use Only)
                const imgRes = await fetch(searchUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

            } catch (e) { intel.debug.push(`Prep Warning: ${e.message}`); }
        }

        // --- STEP 2: STRICT VISUAL SEARCH ---
        // We ONLY search the image. No text fallback. This prevents "random" results.
        if (apiKey && !isAudio) {
            let rawMatches = [];

            try {
                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: searchUrl }) // Send the optimized URL
                });
                
                const lData = await lRes.json();
                
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Fingerprint (Strict)";
                else intel.debug.push("Visual Search found 0 matches");

            } catch (e) { intel.debug.push("Lens API Error"); }

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

        // --- FINAL STATUS ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "System",
                title: "No Visual Matches Found",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Image appears to be unique/synthetic"
            });
        }

        return res.status(200).json({
            service: "osint-titan-v32",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
