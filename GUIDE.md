# How to use Crawler Free: a step-by-step guide

Crawler Free reads web pages for you. You send it a web address and it sends back:

- **the page's text** as clean Markdown, without menus, ads or cookie banners
- **the links** on the page
- **specific facts** you ask for, such as a product's name and price, as neat JSON
- or **a whole website**, page by page (a "crawl")

It's free and needs no account or key. You only need a terminal window.

The service lives at:

```
https://crawler-free.crawler-free.workers.dev
```

---

## Step 1: Open a terminal

- **Windows:** press the Windows key, type `PowerShell`, and open **Windows PowerShell**.
- **Mac:** press Cmd + Space, type `Terminal`, and press Enter.
- **Linux:** open your Terminal app.

Every example below has a **Windows (PowerShell)** version and a **Mac / Linux** version. Use the one for your computer.

---

## Step 2: Read one page

Copy the command, change the web address to the page you want, paste it into the terminal, and press Enter.

**Windows (PowerShell)**
```powershell
(Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/scrape" -ContentType "application/json" -Body (@{ url = "https://quotes.toscrape.com/" } | ConvertTo-Json)).data.markdown
```

**Mac / Linux**
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/scrape" -H "Content-Type: application/json" -d '{"url": "https://quotes.toscrape.com/"}'
```

The page's main text appears on screen. (On Mac/Linux it's wrapped in a little JSON, with the text under `"markdown"`.)

---

## Step 3: Save the page to a file

**Windows (PowerShell)**
```powershell
(Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/scrape" -ContentType "application/json" -Body (@{ url = "https://quotes.toscrape.com/" } | ConvertTo-Json)).data.markdown | Set-Content page.md -Encoding UTF8
```

**Mac / Linux**
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/scrape" -H "Content-Type: application/json" -d '{"url": "https://quotes.toscrape.com/"}' -o page.json
```

This creates `page.md` (Windows) or `page.json` (Mac/Linux) in the folder your terminal is in. Open it with any text editor.

---

## Step 4: Get the links on a page

Add `formats` with `"links"`. You can ask for both the text and the links at once.

**Windows (PowerShell)**
```powershell
(Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/scrape" -ContentType "application/json" -Body (@{ url = "https://quotes.toscrape.com/"; formats = @("markdown", "links") } | ConvertTo-Json)).data.links
```

**Mac / Linux**
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/scrape" -H "Content-Type: application/json" -d '{"url": "https://quotes.toscrape.com/", "formats": ["markdown", "links"]}'
```

---

## Step 5: Pull out only the facts you want

Tell Crawler Free which fields you want and an AI fills them in from the page. List each field under `properties`. This example gets a book's title, price and stock status:

**Windows (PowerShell)**
```powershell
$body = @{ url = "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"; formats = @(@{ type = "json"; schema = @{ type = "object"; properties = @{ title = @{ type = "string" }; price = @{ type = "string" }; availability = @{ type = "string" } } } }) } | ConvertTo-Json -Depth 10
(Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/scrape" -ContentType "application/json" -Body $body).data.json
```

**Mac / Linux**
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/scrape" -H "Content-Type: application/json" -d '{"url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", "formats": [{"type": "json", "schema": {"type": "object", "properties": {"title": {"type": "string"}, "price": {"type": "string"}, "availability": {"type": "string"}}}}]}'
```

Result (the order of the fields may differ):

```
title        : A Light in the Attic
price        : £51.77
availability : In stock (22 available)
```

**To get different facts**, change the web address and the field names, for example `name`, `opening_hours` and `address` for a shop page. Keep `-Depth 10` in the Windows version: without it, PowerShell silently cuts off the field list. You can also add `prompt = "..."` (Windows) or `"prompt": "..."` (Mac/Linux) next to `schema` to give the AI extra instructions.

---

## Step 6: Read a whole website (crawl)

A crawl starts at one page, follows its links, and reads up to 50 pages of the same site. It runs in the background and takes from a few seconds to a few minutes.

### 6a. Start the crawl

**Windows (PowerShell)**
```powershell
$job = Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/crawl" -ContentType "application/json" -Body (@{ url = "https://books.toscrape.com/"; limit = 20 } | ConvertTo-Json)
```

**Mac / Linux**
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/crawl" -H "Content-Type: application/json" -d '{"url": "https://books.toscrape.com/", "limit": 20}'
```

- `limit` is how many pages to read, up to 50 (default 10).
- You can add `maxDiscoveryDepth` (0–3, default 2): how many clicks away from the start page to go.
- The crawl stays on the same website, inside the start page's folder.

### 6b. Wait for it to finish

**Windows (PowerShell):** this waits and shows progress until the crawl is done.
```powershell
do { Start-Sleep 3; $s = Invoke-RestMethod -Uri $job.url; "$($s.completed)/$($s.total) pages" } while ($s.status -eq "scraping")
```

**Mac / Linux:** Step 6a printed an `"id"`. Put it in place of `JOB_ID` and run this every few seconds until it says `"status":"completed"`:
```bash
curl -s "https://crawler-free.crawler-free.workers.dev/v2/crawl/JOB_ID"
```

### 6c. Collect and save the pages

Results come 10 pages at a time. Each answer has a `next` address for the next 10, until `next` is empty.

**Windows (PowerShell):** collects every page and saves each one as `crawl-out\page1.md`, `page2.md`, and so on.
```powershell
$pages = @($s.data); while ($s.next) { $s = Invoke-RestMethod -Uri $s.next; $pages += $s.data }
New-Item -ItemType Directory crawl-out -Force | Out-Null; $i = 0; foreach ($p in $pages) { $i++; $p.markdown | Set-Content "crawl-out\page$i.md" -Encoding UTF8 }
```

**Mac / Linux:** open the address after `"next"` the same way, adding `?skip=10`, `?skip=20` and so on to the status address.

Crawl results are kept for **24 hours**, then deleted.

---

## Using it from your own program

Crawler Free speaks the same language as Firecrawl, so the official Firecrawl SDK works with it. For JavaScript or Node.js, install it with `npm install @mendable/firecrawl-js`, then:

```js
import Firecrawl from "@mendable/firecrawl-js";

const app = new Firecrawl({ apiKey: "fc-keyless", apiUrl: "https://crawler-free.crawler-free.workers.dev" });

const page = await app.scrape("https://quotes.toscrape.com/", { formats: ["markdown", "links"] });
console.log(page.markdown);

const site = await app.crawl("https://books.toscrape.com/", { limit: 20 }); // waits until finished
console.log(site.data.length, "pages");
```

The key `fc-keyless` is a placeholder. No real key is needed.

---

## If something goes wrong

Every error has a `code` that says what happened:

| Code | What it means | What to do |
|---|---|---|
| `RATE_LIMITED` | You went over the free limit (see below) | Wait the number of seconds in the `Retry-After` header and try again |
| `ROBOTS_DISALLOWED` | The website asks bots not to read that page | Nothing; Crawler Free respects that |
| `BLOCKED` | The website refused or put up a bot check | Nothing; Crawler Free never tries to get around blocks |
| `URL_BLOCKED` | The address is private, local, or not `http`/`https` | Use a normal public web address |
| `RENDER_BUDGET_EXHAUSTED` | The page needs JavaScript and today's free browser time is used up | Try again after midnight UTC |
| `EXTRACT_BUDGET_EXHAUSTED` | Today's free AI budget (Step 5) is used up | Try again after midnight UTC |
| `EXTRACT_FAILED` | The AI couldn't find all the fields you asked for | Use fields that really appear on the page, or add a `prompt` |
| `NOT_FOUND` | That crawl ID doesn't exist or is older than 24 hours | Start a new crawl |
| `DISABLED` | The service is switched off for maintenance | Try again later |
| `SCRAPE_TIMEOUT` / `SCRAPE_FAILED` | The website was too slow, too large (over 5 MB) or not a web page | Check the address, or try later |
| `BAD_REQUEST` | Something in your command is wrong | Compare it with the examples above |

If the response contains a `warning`, it still worked; it's just telling you that something you sent was ignored.

**Strange characters such as `â€œ` instead of quotes?** Make sure you save files with `-Encoding UTF8` (Windows), as in the examples.

---

## Free limits

These are per internet connection:

| What | Limit |
|---|---|
| Reading pages (Steps 2–4) | 20 per minute |
| Pulling out facts (Step 5) | 20 per day |
| Crawls (Step 6) | 5 per day, up to 50 pages each |

Asking for the same page again within an hour is answered instantly from memory.

---

## What Crawler Free will not do

It identifies itself honestly as `CrawlerFree`, always follows each site's `robots.txt` rules, and stops when a site says no. It can't log in, fill in forms, read pages behind a login, solve CAPTCHAs, or get past bot protection.

Questions, problems, or a site owner who wants to opt out: https://github.com/artthavv999/crawler-free/issues
