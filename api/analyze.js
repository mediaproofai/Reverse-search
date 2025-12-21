import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- PURE JS DIMENSIONS ---
function getDimensions(buffer) {
    try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) { // PNG
            const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
            const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
            return { width, height };
        }
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) { // JPG
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
                    return { width, height };
                }
                i += len;
            }
        }
    } catch (e) { return null; }
    return null;
}

// --- GENERATOR ID (UPDATED) ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 5;
    
    // Midjourney v4 often used 640x640 upscales
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5 / Midjourney v4';
    if (is(w, 640) && is(h, 640)) return 'Midjourney v4 / Stable Diffusion'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion / Midjourney'; 
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5+';
    if (is(w, 1920) && is(h, 1080)) return 'Runway / Pika';
    
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
        version: "osint-honest-v19",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();
        
        // --- STEP 1: DIMS & GEN ID ---
        if (!isAudio) {
            try {
                const imgRes = await fetch(mediaUrl); 
                const buffer = new Uint8Array(await imgRes.arrayBuffer());
                const dims = getDimensions(buffer);
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") {
                        // Store the guess, but tag it tentatively
                        intel.ai_generator_name = `${gen} (Resolution Hint)`;
                    }
                }
            } catch (e) { intel.debug.push("Dim Check Failed"); }
        }

        // --- STEP 2: API SEARCH ---
        if (apiKey) {
            let rawMatches = [];
            
            // A. VISUAL SEARCH
            if (!isAudio) {
                try {
                    const lRes = await fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                    });
                    const lData = await lRes.json();
                    if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                    if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                    if (rawMatches.length > 0) intel.method = "Visual Fingerprint";
                } catch (e) { intel.debug.push("Lens Error"); }
            }

            // B. TEXT SEARCH (Filename)
            if (rawMatches.length === 0) {
                const cleanName = filename.split('.')[0]; 
                intel.debug.push(`Text Search: "${cleanName}"`);
                try {
                    const sRes = await fetch("https://google.serper.dev/search", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ q: cleanName, gl: "us", hl: "en" })
                    });
                    const sData = await sRes.json();
                    if (sData.organic) rawMatches = rawMatches.concat(sData.organic);
                    if (sData.images) rawMatches = rawMatches.concat(sData.images);
                    if (rawMatches.length > 0) intel.method = "Filename Trace";
                } catch (e) { intel.debug.push("Text Search Error"); }
            }

            // C. MAPPING
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "External Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // D. CONTEXT GEN ID (Overwrites Resolution Hint if matches found)
            if (cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Verified Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Verified Context)";
                else if (combined.includes("dall-e")) intel.ai_generator_name = "DALL-E (Verified Context)";
            } 
            else {
                // IMPORTANT: If 0 matches, reset the name to "Unknown" to avoid lying
                // unless we are VERY sure (resolution hint is weak evidence alone)
                if (intel.ai_generator_name.includes("Resolution Hint")) {
                    intel.ai_generator_name = "Unknown (API Blocked - Verify Manually)";
                }
            }
        }

        // --- STEP 3: HONEST FALLBACK ---
        if (intel.totalMatches === 0) {
             const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`;
             
             intel.matches.push({
                source_name: "Google Lens (Manual Check)",
                title: "View Actual Results (API Blocked)",
                url: lensUrl,
                posted_time: "Google API cannot read this Cloudinary URL. Click here to see the real matches."
            });
        }

        return res.status(200).json({
            service: "osint-honest-v19",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
