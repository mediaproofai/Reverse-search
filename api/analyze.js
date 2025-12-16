import fetch from 'node-fetch';

// CONFIGURATION
const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable diffusion', 'sdxl', 'civitai'] },
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
        version: "osint-zero-dep-v8", // VERIFY THIS IN DEBUG
        debug: []
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
                
                if (lensRes.ok) {
                    const lensData = await lensRes.json();
                    if (lensData.knowledgeGraph) rawMatches.push(lensData.knowledgeGraph);
                    if (lensData.visualMatches) rawMatches = rawMatches.concat(lensData.visualMatches);
                    if (rawMatches.length > 0) intel.method = "Visual Fingerprint";
                } else {
                    intel.debug.push(`Lens Error: ${lensRes.status}`);
                }
            } catch (e) { intel.debug.push("Lens failed"); }

            // --- STRATEGY 2: TEXT FALLBACK (If Visual Failed) ---
            if (rawMatches.length === 0) {
                // "image_123.jpg" -> "image 123"
                const filename = mediaUrl.split('/').pop().split('.')[0].replace(/[-_]/g, ' ');
                
                // Only search if filename is meaningful (longer than 3 chars)
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
                    } catch (e) { intel.debug.push("Text fallback failed"); }
                }
            }

            // --- PROCESSING ---
            // 1. Clean Results (Remove Self-Links)
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            
            // 2. Map for Frontend
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "Visual Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // 3. DETECT GENERATOR (Context Scan)
            // Look for keywords in the titles of the search results we found
            if (cleanMatches.length > 0) {
                const combinedText = cleanMatches.map(m => (m.title + " " + m.source).toLowerCase()).join(" ");
                
                for (const gen of AI_LABS) {
                    if (gen.keys.some(k => combinedText.includes(k))) {
                        intel.ai_generator_name = `${gen.name} (Context Match)`;
                        break;
                    }
                }
            }
        }

        // --- FALLBACK MESSAGE ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "System",
                title: "No Public Matches Found",
                url: "#",
                posted_time: "Image appears unique/private"
            });
        }

        return res.status(200).json({
            service: "osint-zero-dep-v8",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.totalMatches > 0 ? "Publicly Indexed" : "Private",
                last_seen: "Just Now" 
            }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-crash", error: e.message });
    }
}
