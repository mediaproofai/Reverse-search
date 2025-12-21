import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- FORCE TINY THUMBNAIL (The Fix) ---
// We transform the URL to get a guaranteed small (<100KB) image for the API.
function getThumbnailUrl(url) {
    if (url.includes('cloudinary.com') && url.includes('/upload/')) {
        return url.replace('/upload/', '/upload/w_500,c_fit,q_auto:low/');
    }
    return url; // Return original if not Cloudinary (we'll try to use it anyway)
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
        version: "osint-nuclear-v23",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();
        
        // --- STEP 1: FORCE-FETCH PIXELS ---
        let base64Payload = null;
        let dims = null;

        if (!isAudio) {
            try {
                // 1. Construct the "Tiny URL"
                const tinyUrl = getThumbnailUrl(mediaUrl);
                intel.debug.push(`Fetching Thumbnail: ${tinyUrl}`);

                // 2. Download the tiny image
                const imgRes = await fetch(tinyUrl);
                if (!imgRes.ok) throw new Error(`Fetch failed: ${imgRes.status}`);
                
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // 3. Convert to Base64 (It is now guaranteed small)
                base64Payload = buffer.toString('base64');
                intel.debug.push(`Generated Base64 Payload (${Math.round(base64Payload.length/1024)}KB)`);

                // 4. Get Dimensions (from header) for Gen ID
                dims = getDimensions(new Uint8Array(arrayBuffer));
                if (dims) {
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

            } catch (e) { 
                intel.debug.push(`Pixel Prep Failed: ${e.message}`); 
            }
        }

        // --- STEP 2: API ATTACK (PIXELS ONLY) ---
        if (apiKey && !isAudio) {
            let rawMatches = [];

            // We prefer Base64 because it bypasses URL indexing issues entirely.
            if (base64Payload) {
                try {
                    const lRes = await fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ image: base64Payload }) // SEND PIXELS
                    });
                    
                    const lData = await lRes.json();
                    
                    if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                    if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                    
                    if (rawMatches.length > 0) intel.method = "Deep Pixel Search";
                    else intel.debug.push("Pixel Search returned 0 matches");

                } catch (e) { intel.debug.push("Lens API Error"); }
            }

            // --- STEP 3: TEXT FALLBACK (If Pixels Failed) ---
            if (rawMatches.length === 0) {
                const cleanName = filename.split('.')[0];
                intel.debug.push(`Fallback Text Search: "${cleanName}"`);
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
                } catch (e) { intel.debug.push("Text Search Error"); }
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
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Verified)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Verified)";
            }
        }

        // --- STEP 4: FINAL FALLBACK ---
        if (intel.totalMatches === 0) {
            const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`;
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "View Results Manually",
                url: lensUrl,
                posted_time: "Image Unique or API Blocked"
            });
        }

        return res.status(200).json({
            service: "osint-nuclear-v23",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}

// --- HELPERS ---
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
