import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

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
        version: "osint-pixel-mode-v20",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        
        // --- STEP 1: DOWNLOAD & CONVERT TO BASE64 ---
        // We do this to bypass the "URL not indexed" issue.
        // We send the RAW PIXELS to Google.
        let base64Image = null;
        let dims = null;

        if (!isAudio) {
            try {
                const imgRes = await fetch(mediaUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
                // Safety: Only use Base64 if image is under 2MB (Serper Limit)
                if (buffer.length < 2000000) {
                    base64Image = buffer.toString('base64');
                    intel.debug.push(`Converted to Base64 (${Math.round(buffer.length/1024)}KB)`);
                } else {
                    intel.debug.push("File too large for Base64, using URL");
                }

                // Get Dims (Manual Parse)
                dims = getDimensions(new Uint8Array(arrayBuffer));
                if (dims) {
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }
            } catch (e) { intel.debug.push("Download Failed: " + e.message); }
        }

        // --- STEP 2: API SEARCH (PIXEL MODE) ---
        if (apiKey && !isAudio) {
            let rawMatches = [];

            try {
                const payload = { gl: "us", hl: "en" };
                
                // CRITICAL SWITCH: Use 'image' (base64) if available, otherwise 'url'
                if (base64Image) {
                    payload.image = base64Image;
                } else {
                    payload.url = mediaUrl;
                }

                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                
                const lData = await lRes.json();
                
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = base64Image ? "Deep Pixel Search" : "Visual Fingerprint";
                else intel.debug.push("Lens returned 0 matches");

            } catch (e) { intel.debug.push("Lens API Error"); }

            // --- PROCESSING ---
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

            // Context Gen ID
            if (cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context Verified)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context Verified)";
            }
        }

        // --- STEP 3: FINAL FALLBACK ---
        if (intel.totalMatches === 0) {
            const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`;
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "View Results Manually",
                url: lensUrl,
                posted_time: "0 API Matches"
            });
        }

        return res.status(200).json({
            service: "osint-pixel-mode-v20",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}

// --- HELPERS (Keep these at the bottom) ---
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

function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 5;
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5';
    return "Unknown";
}
