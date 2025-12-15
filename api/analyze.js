import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp', 'telegram'];

// KNOWN AI GENERATORS
const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable diffusion', 'sdxl'] },
    { name: 'Sora', keys: ['sora'] },
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
        debug: "Initialized"
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        if (!apiKey) {
            intel.debug = "API Key Missing";
            return res.status(200).json({ service: "osint-no-key", footprintAnalysis: intel });
        }

        // --- VISUAL SEARCH (GOOGLE LENS) ---
        const lensRes = await fetch("https://google.serper.dev/lens", {
            method: "POST",
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
        });

        if (!lensRes.ok) {
            intel.debug = `Lens Error: ${lensRes.status}`;
        } else {
            const data = await lensRes.json();
            
            // 1. COMBINE "KNOWLEDGE GRAPH" AND "VISUAL MATCHES"
            // Knowledge Graph = "This is a cat" (Best Match)
            // Visual Matches = "Here are similar images"
            let allMatches = [];
            if (data.knowledgeGraph) allMatches.push(data.knowledgeGraph);
            if (data.visualMatches) allMatches = allMatches.concat(data.visualMatches);

            // 2. FILTERING (Only remove CDN links, KEEP EVERYTHING ELSE)
            const cleanMatches = allMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            intel.debug = `Found ${cleanMatches.length} raw matches`;

            // 3. MAP RESULTS
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "Visual Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // 4. DETECT GENERATOR FROM SEARCH CONTEXT
            // Scan the titles of the matches for AI keywords
            const combinedText = cleanMatches.map(m => (m.title + " " + m.source).toLowerCase()).join(" ");
            
            for (const gen of AI_LABS) {
                if (gen.keys.some(k => combinedText.includes(k))) {
                    intel.ai_generator_name = gen.name;
                    break;
                }
            }
        }

        return res.status(200).json({
            service: "osint-unfiltered-v1",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? "Publicly Indexed" : "Unique",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
