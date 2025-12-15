import fetch from 'node-fetch';

// IGNORED DOMAINS (CDNs & Social Media Wrappers)
const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp', 'telegram'];

// KNOWN AI GENERATORS
const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable-diffusion', 'sdxl'] },
    { name: 'Sora', keys: ['sora'] },
    { name: 'Runway', keys: ['runway'] }
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
        isViral: false,
        ai_generator_name: "Unknown",
        matches: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        if (apiKey) {
            // *** THE FIX: USE GOOGLE LENS (VISION SEARCH) ***
            // We send the URL, not text keywords.
            const response = await fetch("https://google.serper.dev/lens", {
                method: "POST",
                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
            });
            
            const data = await response.json();
            
            // Serper Lens returns 'knowledgeGraph' or 'visualMatches'
            const visualMatches = data.visualMatches || [];
            
            // Filter Matches
            const cleanMatches = visualMatches.filter(m => 
                !IGNORED.some(d => m.link.includes(d) || m.source.includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            intel.isViral = cleanMatches.length > 50;

            // Map Results
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || new URL(m.link).hostname,
                title: m.title || "Visual Match",
                url: m.link,
                posted_time: "Found by Visual Search" // Lens often lacks dates
            }));

            // DETECT GENERATOR FROM SEARCH CONTEXT
            // We scan the titles of the visual matches for AI keywords
            const combinedText = cleanMatches.map(m => (m.title + " " + m.source).toLowerCase()).join(" ");
            
            for (const gen of AI_LABS) {
                if (gen.keys.some(k => combinedText.includes(k))) {
                    intel.ai_generator_name = gen.name;
                    break;
                }
            }
        }

        // Return Result
        return res.status(200).json({
            service: "osint-vision-lens-v1",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? "Found Online" : "Unique",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        // Fallback if Lens fails
        return res.status(200).json({ 
            service: "osint-error", 
            footprintAnalysis: intel, 
            error: e.message 
        });
    }
}
