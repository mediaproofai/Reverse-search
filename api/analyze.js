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

// --- GENERATOR ID ---
function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 5;
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5';
    if (is(w, 1920) && is(h, 1080)) return 'Runway / Pika';
    return "Unknown";
}

// --- GARBAGE DETECTOR ---
// Returns TRUE if the string looks like a random ID (e.g. "ghgxy1qbxyzwjvbbox7u")
function isGarbage(text) {
    if (!text) return true;
    if (text.length > 12 && !text.includes(' ') && !text.includes('-') && !text.includes('_')) return true; // Long single string
    if (text.match(/[0-9]{5,}/) && text.match(/[a-z]{5,}/)) return true; // Mixed long alphanumerics
    return false;
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
        version: "osint-integrity-v17",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop().toLowerCase();
        
        // --- STEP 1: DIMS & GEN ID (Always Run) ---
        if (!isAudio) {
            try {
                const imgRes = await fetch(mediaUrl); 
                const buffer = new Uint8Array(await imgRes.arrayBuffer());
                const dims = getDimensions(buffer);
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }
            } catch (e) { intel.debug.push("Dim Check Failed"); }
        }

        // --- STEP 2: API SEARCH ---
        if (apiKey) {
            let rawMatches = [];
            
            // A. VISUAL SEARCH (LENS) - The only source of truth for images
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

            // B. TEXT SEARCH (Selective)
            // Only run if Visual Failed AND Filename looks human-readable
            if (rawMatches.length === 0) {
                const cleanName = filename.split('.')[0].replace(/[-_]/g, ' '); // simple cleanup
                
                if (!isGarbage(cleanName)) {
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
                } else {
                    intel.debug.push("Skipped Text Search (Garbage Filename)");
                }
            }

            // C. CLEAN & MAP
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

            // D. CONTEXT GEN ID
            if (intel.ai_generator_name.includes("Unknown") && cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- STEP 3: FALLBACK ---
        if (intel.totalMatches === 0) {
             intel.matches.push({
                source_name: "System",
                title: "No Public Matches",
                url: "#",
                posted_time: "Unique File"
            });
        }

        return res.status(200).json({
            service: "osint-integrity-v17",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
