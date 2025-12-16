import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// 1. RESOLUTION FINGERPRINTS
const RES_MAP = {
    '512x512': 'Stable Diffusion v1.5 / Midjourney v4',
    '640x640': 'Stable Diffusion v1.5 (Upscaled)',
    '768x768': 'Stable Diffusion v2.0',
    '1024x1024': 'SDXL / DALL-E 3 / Midjourney v5+',
    '1216x832': 'SDXL (Landscape)',
    '832x1216': 'SDXL (Portrait)',
    '1024x1792': 'Midjourney (Tall)',
    '1792x1024': 'Midjourney (Wide)',
    '1920x1080': 'Runway Gen-2 / Pika Labs'
};

// 2. FILENAME PATTERNS
const PATTERNS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_', 'grid_0'] },
    { name: 'ElevenLabs', keys: ['elevenlabs', '11labs'] },
    { name: 'Suno AI', keys: ['suno'] },
    { name: 'Udio', keys: ['udio'] },
    { name: 'Sora', keys: ['sora'] }
];

// --- HELPER: PURE JS DIMENSION PARSER (No Deps) ---
function getDimensions(buffer) {
    try {
        // PNG Header
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
            const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
            return { width, height };
        }
        // JPEG Header Scan
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
            let i = 2;
            while (i < buffer.length) {
                if (buffer[i] !== 0xFF) return null; 
                while (buffer[i] === 0xFF) i++;
                const marker = buffer[i];
                i++;
                const len = (buffer[i] << 8) | buffer[i + 1];
                if (marker >= 0xC0 && marker <= 0xC3) { // Start of Frame
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
        version: "osint-nuclear-v12",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop().toLowerCase();
        
        // --- PHASE 1: DIRECT DOWNLOAD FORENSICS ---
        // We download the first 32KB to parse headers ourselves
        if (!isAudio) {
            try {
                const imgRes = await fetch(mediaUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = new Uint8Array(arrayBuffer);
                const dims = getDimensions(buffer);

                if (dims) {
                    const resKey = `${dims.width}x${dims.height}`;
                    intel.debug.push(`Parsed Dimensions: ${resKey}`);
                    if (RES_MAP[resKey]) {
                        intel.ai_generator_name = `${RES_MAP[resKey]} (Resolution Match)`;
                    } else if (dims.width === 1024 || dims.height === 1024) {
                        intel.ai_generator_name = "Possible Generative Model (1024px)";
                    }
                }
            } catch (e) { intel.debug.push("Download/Parse Error: " + e.message); }
        } else {
             // Audio Pattern Check
             for (const gen of PATTERNS) {
                 if (gen.keys.some(k => filename.includes(k))) intel.ai_generator_name = gen.name;
             }
        }

        // --- PHASE 2: SEARCH EXECUTION ---
        if (apiKey) {
            let rawMatches = [];

            if (isAudio) {
                // Audio Text Search
                const cleanName = filename.split('.')[0].replace(/[-_]/g, ' ');
                if (cleanName.length > 5) {
                    try {
                        const sRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: `"${cleanName}"`, gl: "us", hl: "en" })
                        });
                        const sData = await sRes.json();
                        rawMatches = sData.organic || [];
                        if (rawMatches.length > 0) intel.method = "Audio Filename Trace";
                    } catch (e) {}
                }
            } else {
                // Visual Lens Search
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
                } catch (e) { intel.debug.push("Lens API Error"); }
            }

            // --- PHASE 3: RESULTS & CONTEXT ---
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

            // Context Gen Detection
            if (intel.ai_generator_name.includes("Unknown") && cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
                else if (combined.includes("sora")) intel.ai_generator_name = "Sora";
            }
        }

        // --- PHASE 4: HONEST FALLBACK ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "System",
                title: isAudio ? "Audio Search Unavailable" : "No Visual Matches",
                url: "#",
                posted_time: "File ID or pixels not indexed"
            });
        }

        return res.status(200).json({
            service: "osint-nuclear-v12",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
