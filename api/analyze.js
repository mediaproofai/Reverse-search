import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- GENERATOR LOGIC (Restored) ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 5;
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5';
    return "Unknown";
}

// --- DIMENSION PARSER ---
function getDimensions(buffer) {
    try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) { 
            const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
            const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
            return { width, height };
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
                    return { width, height };
                }
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
        version: "osint-restored-v24",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- STEP 1: FETCH ORIGINAL IMAGE ---
        // We fetch the REAL image first to get accurate dimensions and quality pixels.
        let base64Payload = null;
        let originalBuffer = null;

        if (!isAudio) {
            try {
                const imgRes = await fetch(mediaUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                originalBuffer = Buffer.from(arrayBuffer);
                
                // 1. Check Dimensions on ORIGINAL
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                if (dims) {
                    intel.debug.push(`Original Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

                // 2. Prepare Payload (Max 4MB for API)
                if (originalBuffer.length < 4000000) {
                    base64Payload = originalBuffer.toString('base64');
                    intel.debug.push(`Using Original Quality (${Math.round(originalBuffer.length/1024)}KB)`);
                } else {
                    // Fallback: If original is HUGE, *then* use the Cloudinary shrink trick
                    intel.debug.push("Image > 4MB, switching to optimized version");
                    const miniUrl = mediaUrl.replace('/upload/', '/upload/w_1000,q_auto/');
                    const miniRes = await fetch(miniUrl);
                    const miniBuf = await miniRes.buffer();
                    base64Payload = miniBuf.toString('base64');
                }

            } catch (e) { intel.debug.push(`Prep Failed: ${e.message}`); }
        }

        // --- STEP 2: HIGH-FIDELITY SEARCH ---
        if (apiKey && !isAudio && base64Payload) {
            let rawMatches = [];

            try {
                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ image: base64Payload })
                });
                
                const lData = await lRes.json();
                
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Fingerprint (High Res)";
                else intel.debug.push("Lens API returned 0 matches");

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

            // Context Gen ID
            if (cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- STEP 3: FALLBACK ---
        if (intel.totalMatches === 0) {
            const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`;
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "View Results Manually",
                url: lensUrl,
                posted_time: "API Blocked or Unique Image"
            });
        }

        return res.status(200).json({
            service: "osint-restored-v24",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
