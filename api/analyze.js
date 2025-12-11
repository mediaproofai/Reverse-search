import fetch from 'node-fetch';

const IGNORED_DOMAINS = ['cloudinary.com', 'vercel.app', 'blob:', 'localhost'];

// AI Generators to scan for in search text
const AI_SIGNATURES = [
    'Midjourney', 'Stable Diffusion', 'DALL-E', 'Sora', 'Runway', 'Pika', 'Kaiber', 'HeyGen', 'ElevenLabs'
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        isViral: false,
        ai_generator_name: "Unknown", // New Field
        matches: [] // New Field: Literal Links
    };

    try {
        if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

        if (apiKey) {
            const response = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ q: mediaUrl, type: "images", gl: "us", hl: "en" })
            });
            
            const data = await response.json();
            
            if (data.images) {
                // Filter self-matches
                const validMatches = data.images.filter(img => 
                    !IGNORED_DOMAINS.some(d => img.link.includes(d) || img.source.includes(d))
                );

                intel.totalMatches = validMatches.length;
                intel.isViral = validMatches.length > 10;

                // Extract Detailed Matches
                intel.matches = validMatches.slice(0, 5).map(m => ({
                    source_name: m.source,
                    title: m.title,
                    url: m.link,
                    posted_time: m.date || "Unknown date", // Serper sometimes provides 'date'
                    domain: new URL(m.link).hostname
                }));

                // Heuristic: Identify Generator Name from Context
                // We scan the titles of the search results for AI keywords
                const combinedText = validMatches.map(m => m.title + " " + m.snippet).join(" ").toLowerCase();
                for (const gen of AI_SIGNATURES) {
                    if (combinedText.includes(gen.toLowerCase())) {
                        intel.ai_generator_name = gen;
                        break;
                    }
                }
            }
        }

        return res.status(200).json({
            service: "osint-deep-dive-v1",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? intel.matches[intel.matches.length-1].posted_time : "N/A",
                last_seen: intel.matches.length > 0 ? intel.matches[0].posted_time : "N/A"
            }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-error-bypass", footprintAnalysis: intel, error: e.message });
    }
}
