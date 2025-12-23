import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- GENERATOR ID (Standard) ---
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
        version: "osint-origin-v33",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- STEP 1: METADATA (Internal Only) ---
        if (!isAudio) {
            try {
                // Fetch just to get dimensions for the generator ID
                const imgRes = await fetch(mediaUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }
            } catch (e) { intel.debug.push("Dim Check Failed"); }
        }

        if (apiKey && !isAudio) {
            let rawMatches = [];

            // --- STRATEGY A: RAW URL VISUAL SEARCH ---
            // Sending the EXACT original link. No resizing. No quality changes.
            try {
                intel.debug.push(`Scanning Original URL`);
                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: mediaUrl }) 
                });
                
                const lData = await lRes.json();
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Search (Original)";
                else intel.debug.push("Visual Search: 0 Matches");
            } catch (e) { intel.debug.push("Visual API Error"); }

            // --- STRATEGY B: FILENAME TEXT SEARCH ---
            // Unfiltered. If the name is "brmol65...", we search it.
            const cleanName = filename.split('.')[0];
            try {
                intel.debug.push(`Searching Text: "${cleanName}"`);
                const sRes = await fetch("https://google.serper.dev/search", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ q: cleanName })
                });
                const sData = await sRes.json();
                if (sData.organic) rawMatches = rawMatches.concat(sData.organic);
                if (sData.images) rawMatches = rawMatches.concat(sData.images);

                if (rawMatches.length > 0 && intel.method === "None") intel.method = "Filename Trace";
            } catch (e) { intel.debug.push("Text API Error"); }

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

        // --- FINAL STATUS ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "No Matches - Click to Verify",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Image is unique or API blocked"
            });
        }

        return res.status(200).json({
            service: "osint-origin-v33",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
