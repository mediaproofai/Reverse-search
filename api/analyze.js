import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    try {
        let matches = [];
        if (apiKey) {
            const response = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ q: mediaUrl, type: "images" }) // Reverse Image Search
            });
            const data = await response.json();
            matches = data.images || [];
        }

        // Sort by date (if available) or assume order is relevance
        // In a real OSINT tool, we'd scrape dates from the sites.
        const earliest = matches.length > 0 ? matches[matches.length - 1] : null;

        return res.status(200).json({
            service: "osint-unit",
            footprintAnalysis: {
                totalMatches: matches.length,
                isViral: matches.length > 50,
                sources: {
                    stockParams: matches.some(m => m.source.includes("stock") || m.source.includes("getty")),
                    newsParams: matches.some(m => m.source.includes("news"))
                }
            },
            timelineIntel: {
                patientZero: earliest ? { url: earliest.link, source: earliest.source } : "No history found",
                distribution_graph: "Sparse"
            }
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
