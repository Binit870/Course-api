// api/all-courses.js
// Combined course aggregator for Vercel serverless (node fetch available)
// Deploy this file to /api/all-courses.js in a Vercel project.

// Optional environment variables:
// RAPIDAPI_KEY - RapidAPI key for Udemy endpoint (optional)
// RAPIDAPI_HOST - RapidAPI host for Udemy (default: "udemy-paid-courses-for-free-api.p.rapidapi.com")

export default async function handler(req, res) {
  // Query parameter: ?q=python (defaults to "")
  const q = (req.query.q || "").toString().trim();

  try {
    const promises = [getCoursera(q), getClassCentral(q), getFreeCodeCamp(q), getGeeksForGeeks(q)];

    // If RAPIDAPI_KEY is present, include Udemy source
    if (process.env.RAPIDAPI_KEY) {
      promises.push(getUdemy(q));
    }

    const results = await Promise.allSettled(promises);

    // Flatten only fulfilled results
    const allCourses = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter(Boolean);

    // Basic dedupe by url
    const seen = new Set();
    const deduped = [];
    for (const c of allCourses) {
      const key = (c.url || c.title || Math.random()).toString();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(c);
      }
    }

    // Cache for 1 hour on the edge, allow stale while revalidate
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=59");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    res.status(200).json(deduped);
  } catch (err) {
    console.error("all-courses error:", err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: "Failed to fetch aggregated courses" });
  }
}

// -------------------- Sources --------------------

async function getCoursera(query) {
  try {
    const search = encodeURIComponent(query || "");
    const url = `https://api.coursera.org/api/courses.v1?q=search&query=${search}&fields=photoUrl,description,slug,subtitle`; // limited fields
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const items = (data.elements || []).map((c) => ({
      title: c.name || c.title,
      description: c.description || c.subtitle || "",
      image: c.photoUrl || null,
      url: c.slug ? `https://www.coursera.org/learn/${c.slug}` : null,
      platform: "Coursera",
      free: true,
    }));
    return items;
  } catch (err) {
    console.warn("Coursera failed", err);
    return [];
  }
}

async function getClassCentral() {
  try {
    const url = "https://www.classcentral.com/report/wp-json/cc/list?tag=free-online-course";
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return (data || []).map((c) => ({
      title: c.title,
      description: c.description || "",
      image: c.image || null,
      url: c.url || null,
      platform: "Class Central",
      free: true,
    }));
  } catch (err) {
    console.warn("ClassCentral failed", err);
    return [];
  }
}

async function getFreeCodeCamp(_) {
  try {
    // freeCodeCamp curriculum is large; we pull a lightweight summary from their repo
    const url = "https://raw.githubusercontent.com/freeCodeCamp/freeCodeCamp/main/curriculum/challenges/english/00-getting-started/freecodecamp-basics.json";
    // NOTE: freeCodeCamp's repo structure changes occasionally. This endpoint is a lightweight attempt
    const r = await fetch(url);
    if (!r.ok) {
      // fallback: return a single generic freeCodeCamp entry
      return [
        {
          title: "freeCodeCamp Learn",
          description: "freeCodeCamp's self-paced curriculum (Responsive Web Design, JavaScript Algorithms, Front End Libraries, etc.)",
          image: "https://design-style-guide.freecodecamp.org/downloads/fcc_secondary_small.svg",
          url: "https://www.freecodecamp.org/learn",
          platform: "freeCodeCamp",
          free: true,
        },
      ];
    }
    const data = await r.json();
    // data is a single challenge object; map to a simple entry
    return [
      {
        title: data.title || "freeCodeCamp: Learn",
        description: data.description || "freeCodeCamp curriculum",
        image: "https://design-style-guide.freecodecamp.org/downloads/fcc_secondary_small.svg",
        url: "https://www.freecodecamp.org/learn",
        platform: "freeCodeCamp",
        free: true,
      },
    ];
  } catch (err) {
    console.warn("freeCodeCamp failed", err);
    return [
      {
        title: "freeCodeCamp: Learn",
        description: "freeCodeCamp curriculum",
        image: "https://design-style-guide.freecodecamp.org/downloads/fcc_secondary_small.svg",
        url: "https://www.freecodecamp.org/learn",
        platform: "freeCodeCamp",
        free: true,
      },
    ];
  }
}

async function getGeeksForGeeks(query) {
  try {
    const url = "https://www.geeksforgeeks.org/feed/";
    const r = await fetch(url);
    if (!r.ok) return [];
    const text = await r.text();
    // Very light XML parsing to extract items (title + link + description)
    const items = [];
    const itemRe = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi;
    let m;
    while ((m = itemRe.exec(text)) !== null) {
      const title = stripTags(m[1] || "").trim();
      const link = stripTags(m[2] || "").trim();
      const desc = stripTags(m[3] || "").trim();
      if (query) {
        const q = query.toLowerCase();
        if (!title.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) continue;
      }
      items.push({
        title,
        description: desc,
        image: null,
        url: link,
        platform: "GeeksforGeeks",
        free: true,
      });
      if (items.length >= 20) break; // limit
    }
    return items;
  } catch (err) {
    console.warn("GFG failed", err);
    return [];
  }
}

async function getUdemy(query) {
  try {
    const apiKey = process.env.RAPIDAPI_KEY;
    const apiHost = process.env.RAPIDAPI_HOST || "udemy-paid-courses-for-free-api.p.rapidapi.com";
    const search = encodeURIComponent(query || "");
    const url = `https://${apiHost}/rapidapi/courses/search?page=1&page_size=20&query=${search}`;
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": apiHost,
      },
    });
    if (!r.ok) return [];
    const data = await r.json();
    const arr = (data.courses || []).map((c) => ({
      title: c.title || c.name,
      description: c.headline || c.description || "",
      image: c.image_480x270 || c.image_240x135 || null,
      url: c.url || null,
      platform: "Udemy",
      free: Boolean(c.coupon),
    }));
    return arr;
  } catch (err) {
    console.warn("Udemy failed", err);
    return [];
  }
}

// utility
function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}
