import fetch from 'node-fetch';

// CONFIG
const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];
const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable diffusion', 'sdxl', 'stablediffusion'] },
    { name: 'Sora', keys: ['sora', 'openai'] },
    { name: 'Runway', keys: ['runway'] },
    { name: 'Pika', keys: ['pika'] }
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-omni-v6" // VERIFY THIS IN YOUR DEBUG LOGS
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        if (apiKey) {
            let rawMatches = [];

            // --- STRATEGY 1: VISUAL SEARCH (LENS) ---
            try {
                const lensRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                });
                const lensData = await lensRes.json();
                
                // Combine Visual Matches + Knowledge Graph
                if (lensData.knowledgeGraph) rawMatches.push(lensData.knowledgeGraph);
                if (lensData.visualMatches) rawMatches = rawMatches.concat(lensData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Fingerprint";
            } catch (e) { console.log("Lens error", e); }

            // --- STRATEGY 2: TEXT FALLBACK (If Visual Failed) ---
            if (rawMatches.length === 0) {
                // "image_123.jpg" -> "image 123"
                const filename = mediaUrl.split('/').pop().split('.')[0].replace(/[-_]/g, ' ');
                
                // Only search if filename has meaningful text (length > 3)
                if (filename.length > 3 && !filename.startsWith("image")) {
                    try {
                        const textRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: filename, gl: "us", hl: "en" })
                        });
                        const textData = await textRes.json();
                        if (textData.images) {
                            rawMatches = textData.images;
                            intel.method = "Filename Lookup";
                        }
                    } catch (e) { console.log("Text fallback error", e); }
                }
            }

            // --- PROCESSING ---
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "Visual Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // DETECT GENERATOR
            const combinedText = cleanMatches.map(m => (m.title + " " + m.source).toLowerCase()).join(" ");
            for (const gen of AI_LABS) {
                if (gen.keys.some(k => combinedText.includes(k))) {
                    intel.ai_generator_name = gen.name;
                    break;
                }
            }
        }

        return res.status(200).json({
            service: "osint-omni-v6",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? "Publicly Indexed" : "Private",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-crash", error: e.message });
    }
}
