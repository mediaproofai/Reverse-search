import fetch from 'node-fetch';  

// --- CONFIGURATION ---
const IGNORED_DOMAINS = [
    'cloudinary.com',
    'vercel.app' //add comma to fix code
    'blob:',
    'localhost',
    'file:',
    'mediaproof' // Your own brand
];

const STOCK_DOMAINS = ['shutter', 'getty', 'adobe', 'stock', 'freepik', 'unsplash', 'pexels', 'dreamstime', 'istock'];
const NEWS_DOMAINS = ['cnn', 'bbc', 'nytimes', 'reuters', 'apnews', 'fox', 'guardian', 'forbes'];
const SOCIAL_DOMAINS = ['twitter', 'youtube', 'x.com', 'reddit', 'facebook', 'instagram', 'linkedin', 'tiktok', 'pinterest'];

export default async function handler(req, res) {
    // 1. ENTERPRISE CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    // Default "Clean" Report
    let intel = {
        totalMatches: 0,
        isViral: false,
        sources: { stockParams: false, newsParams: false, socialParams: false },
        patientZero: { source: "N/A", url: null, date: "Unknown" },
        context: "No digital footprint found (Unique or Private)"
    };

    try {
        if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

        // 2. EXECUTE GLOBAL SEARCH (Serper / Google Lens)
        if (apiKey) {
            const response = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ q: mediaUrl, type: "images", gl: "us", hl: "en" })
            });
            
            const data = await response.json();
            
            if (data.images) {
                // 3. THE "ECHO CHAMBER" FILTER
                // We remove results that point to our own storage or generic CDNs
                const validMatches = data.images.filter(img => {
                    const link = img.link.toLowerCase();
                    const source = img.source.toLowerCase();
                    return !IGNORED_DOMAINS.some(d => link.includes(d) || source.includes(d));
                });

                intel.totalMatches = validMatches.length;
                intel.isViral = validMatches.length > 20;

                // 4. CONTEXT CLASSIFICATION
                intel.sources.stockParams = validMatches.some(m => STOCK_DOMAINS.some(d => m.source.toLowerCase().includes(d)));
                intel.sources.newsParams = validMatches.some(m => NEWS_DOMAINS.some(d => m.source.toLowerCase().includes(d)));
                intel.sources.socialParams = validMatches.some(m => SOCIAL_DOMAINS.some(d => m.source.toLowerCase().includes(d)));

                // 5. FIND PATIENT ZERO (Origin Tracing)
                // We assume the search engine sorts by relevance, but we look for the "Oldest" looking timestamp
                // or simply the last unique entry in the list as a heuristic for origin.
                if (validMatches.length > 0) {
                    // Simple heuristic: Google often puts "Visual Matches" at the top. 
                    // To find the source, we look for high-authority domains or the oldest date string.
                    
                    const datedMatches = validMatches.filter(m => m.date);
                    // If we have dates, sort them. If not, use the list order.
                    
                    let origin = validMatches[0]; // Default to most relevant
                    
                    if (datedMatches.length > 0) {
                        // Attempt to parse "2 days ago", "Nov 2023"
                        // This is fragile, so we use it loosely.
                        origin = datedMatches[datedMatches.length - 1]; // Oldest in the list
                    }

                    intel.patientZero = {
                        source: origin.source,
                        url: origin.link,
                        date: origin.date || "Unknown"
                    };
                }

                // 6. GENERATE HUMAN-READABLE CONTEXT
                if (intel.sources.stockParams) intel.context = "Commercial Stock Photography (Likely Misleading Context)";
                else if (intel.sources.newsParams) intel.context = "Verified News Media Asset";
                else if (intel.isViral) intel.context = "High-Velocity Viral Content";
                else if (intel.totalMatches > 0) intel.context = "Low-Level Internet Presence";
            }
        }

        return res.status(200).json({
            service: "osint-unit-v3-filtered",
            footprintAnalysis: intel,
            timelineIntel: { 
                patientZero: intel.patientZero,
                distribution_graph: intel.isViral ? "Widespread" : "Localized"
            },
            timestamp: new Date().toISOString()
        });

    } catch (e) {
        // Fail Gracefully - Don't crash the Risk Engine
        console.error("OSINT Error:", e);
        return res.status(200).json({ 
            service: "osint-error-bypass", 
            footprintAnalysis: intel, // Return empty intel
            error: e.message 
        });
    }
}
