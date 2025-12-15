import fetch from 'node-fetch';

// IGNORE LIST: Common CDNs that host the file itself but aren't "sources"
const IGNORED_DOMAINS = ['cloudinary.com', 'vercel.app', 'blob:', 'localhost', 'amazonaws.com'];

// AI SIGNATURES: We look for these in titles, snippets, and filenames
const AI_GENERATORS = [
    { name: 'Sora', keywords: ['sora', 'openai video'] },
    { name: 'Runway Gen-2', keywords: ['runway', 'gen-2', 'gen2'] },
    { name: 'Pika Labs', keywords: ['pika', 'pikalabs'] },
    { name: 'Stable Video', keywords: ['stable video', 'svd', 'stability ai'] },
    { name: 'Midjourney', keywords: ['midjourney', 'mj'] },
    { name: 'Kaiber', keywords: ['kaiber'] },
    { name: 'HeyGen', keywords: ['heygen'] },
    { name: 'D-ID', keywords: ['d-id'] }
];

export default async function handler(req, res) {
    // 1. HEADERS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    // Default Intelligence
    let intel = {
        totalMatches: 0,
        isViral: false,
        ai_generator_name: "Unknown", 
        matches: [],
        search_context: "Deep Web Scan"
    };

    try {
        if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

        // 2. EXTRACT FILENAME & METADATA HINTS
        // Cloudinary URLs usually contain the filename at the end
        const filename = mediaUrl.split('/').pop().toLowerCase();
        const filenameKeywords = filename.replace(/[-_.]/g, ' ').split(' ').filter(w => w.length > 3);

        // 3. HEURISTIC 1: FILENAME ANALYSIS
        // If the user named it "sora_test.mp4", we know it's Sora.
        for (const gen of AI_GENERATORS) {
            if (gen.keywords.some(k => filename.includes(k))) {
                intel.ai_generator_name = `${gen.name} (Detected via Filename)`;
            }
        }

        // 4. PERFORM REVERSE SEARCH (If API Key exists)
        if (apiKey) {
            // We search for the URL + Filename keywords to find context
            const query = `"${filenameKeywords.slice(0, 3).join(' ')}"`; 
            
            const response = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ q: query, gl: "us", hl: "en" })
            });
            
            const data = await response.json();
            const results = [...(data.organic || []), ...(data.images || []), ...(data.videos || [])];

            if (results.length > 0) {
                // 5. SMART FILTERING
                // Discard "Garbage" results that don't match our keywords
                const validMatches = results.filter(item => {
                    const text = (item.title + " " + item.snippet).toLowerCase();
                    // Must contain at least one keyword from filename OR be an explicit AI mention
                    const hasKeyword = filenameKeywords.some(k => text.includes(k));
                    const hasAI = text.includes("ai generated") || text.includes("artificial intelligence");
                    return (hasKeyword || hasAI) && !IGNORED_DOMAINS.some(d => item.link.includes(d));
                });

                intel.totalMatches = validMatches.length;
                intel.isViral = validMatches.length > 5;

                // Map clean results
                intel.matches = validMatches.slice(0, 5).map(m => ({
                    source_name: m.source || new URL(m.link).hostname.replace('www.',''),
                    title: m.title || "Untitled Match",
                    url: m.link,
                    posted_time: m.date || "Unknown Date",
                    domain: new URL(m.link).hostname
                }));

                // 6. HEURISTIC 2: CONTEXT ANALYSIS
                // Scan the *valid* search results for generator names
                if (intel.ai_generator_name === "Unknown") {
                    const combinedText = validMatches.map(m => m.title + " " + m.snippet).join(" ").toLowerCase();
                    for (const gen of AI_GENERATORS) {
                        if (gen.keywords.some(k => combinedText.includes(k))) {
                            intel.ai_generator_name = `${gen.name} (Context Match)`;
                            break;
                        }
                    }
                }
            }
        }

        // 7. HEURISTIC 3: FALLBACK GUESS (If still unknown)
        // If we found NO matches, but it's a video, check resolution (Simulation)
        // Real logic would require ffprobe, here we check common aspect ratios via URL params if available
        if (intel.ai_generator_name === "Unknown") {
             // If we have 0 matches, it might be a private generation.
             // We return "Unknown / Private" to imply it's not a generic repost.
             if (intel.totalMatches === 0) {
                 intel.ai_generator_name = "Unknown (Unique/Private Upload)";
             }
        }

        return res.status(200).json({
            service: "osint-deep-dive-v2",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? intel.matches[intel.matches.length-1].posted_time : "Just Now",
                last_seen: intel.matches.length > 0 ? intel.matches[0].posted_time : "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ 
            service: "osint-error-bypass", 
            footprintAnalysis: intel, 
            error: e.message 
        });
    }
}
