# How to use Crawler Free: a step-by-step guide

Crawler Free reads web pages for you. You send it a web address and it sends back:

- **the page's text** as clean Markdown, without menus, ads or cookie banners
- **the links** on the page
- **specific facts** you ask for, such as a product's name and price, as neat JSON
- or **a whole website**, page by page (a "crawl")

It's free and needs no account or key.

---

## The easy way: use the web page

Open **https://crawler-free.crawler-free.workers.dev** in your browser.

1. Paste the web page address into **Web page address**.
2. Choose what you want: **The page's text**, **All the links**, **Specific facts** (then type the facts, for example `title, price`), or **The whole website** (then choose how many pages).
3. Press **Go**. The answer appears below, with **Copy** and **Download** buttons.

### Do it again with one click: saved setups

If you'll want the same information from the same page again later, such as a product's price, save it once:

1. Fill in the address and what you want, as above.
2. Press **Save as a one-click setup**.

It appears under **Your saved setups**. From then on, it's a single step:

- **On the web page:** press **Run** next to it.
- **From any browser:** open its link (**Copy link**).
- **From a terminal:** press **Copy terminal command**, paste it into PowerShell and press Enter. It looks like this, and prints the answer straight away:

  ```powershell
  irm https://crawler-free.crawler-free.workers.dev/run/in5b3rr6wr
  ```

  On Mac or Linux, use `curl` instead of `irm`.

Good to know:

- If you run a setup again within an hour, you get the saved answer from the last hour; after that it reads the page fresh.
- A setup is deleted if it isn't run for 30 days. Press **Remove** to delete it sooner.
- Anyone with a setup's link can run it, so share it only with people you want to.
- Whole-website reads can't be saved as setups; use **Go** for those.

The rest of this guide shows how to do the same things from a terminal instead.

---

## Using the terminal instead

The service lives at:

```
https://crawler-free.crawler-free.workers.dev
```

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

Get a list of every link on a page, for example to find all the product pages a shop's page points to.

1. Copy the block below.
2. Change the line marked `CHANGE` to your page's address.
3. Paste it into PowerShell and press Enter.

```powershell
$page = "https://quotes.toscrape.com/"   # <-- CHANGE: the page
# Don't change anything below this line
(Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/scrape" -ContentType "application/json" -Body (@{ url = $page; formats = @("links") } | ConvertTo-Json)).data.links
```

After you press Enter, you'll see a list of web addresses, one per line: all the links on that page.

**Mac / Linux:** change the address after `"url":`.
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/scrape" -H "Content-Type: application/json" -d '{"url": "https://quotes.toscrape.com/", "formats": ["links"]}'
```

---

## Step 5: Pull out only the facts you want

Instead of the whole page, get only the facts you name, for example a book's title and price.

1. Copy the block below.
2. Change the two lines marked `CHANGE`: the page's address, and the names of the facts you want.
3. Paste it into PowerShell and press Enter.

```powershell
$page   = "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"   # <-- CHANGE: the page
$fields = "title", "price"                                                               # <-- CHANGE: the facts you want
# Don't change anything below this line
$props = [ordered]@{}; foreach ($f in $fields) { $props[$f] = @{ type = "string" } }
$body = @{ url = $page; formats = @(@{ type = "json"; schema = @{ type = "object"; properties = $props } }) } | ConvertTo-Json -Depth 10
(Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/scrape" -ContentType "application/json" -Body $body).data.json
```

After you press Enter, you'll see each fact you asked for with its answer from the page. Here, the book's title (*A Light in the Attic*) and its price (*£51.77*).

Tips:

- Keep the quotation marks: `"title"` is right, `title` is wrong.
- No spaces in names: use `opening_hours`, not `opening hours`.
- Only ask for facts that are on the page. Otherwise you'll get `EXTRACT_FAILED`.
- You can use this step 20 times per 24 hours. See [Free limits](#free-limits).

**Mac / Linux:** change the address after `"url":`, and the names inside `"properties"`. Each name is written as `"name": {"type": "string"}`.
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/scrape" -H "Content-Type: application/json" -d '{"url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", "formats": [{"type": "json", "schema": {"type": "object", "properties": {"title": {"type": "string"}, "price": {"type": "string"}}}}]}'
```

---

## Step 6: Read a whole website (crawl)

A crawl starts at one page, follows its links and the site's sitemap, and reads up to 100 pages of the same site. It runs in the background and takes from a few seconds to a few minutes.

### 6a. Start the crawl

**Windows (PowerShell)**
```powershell
$job = Invoke-RestMethod -Method Post -Uri "https://crawler-free.crawler-free.workers.dev/v2/crawl" -ContentType "application/json" -Body (@{ url = "https://books.toscrape.com/"; limit = 20 } | ConvertTo-Json)
```

**Mac / Linux**
```bash
curl -s -X POST "https://crawler-free.crawler-free.workers.dev/v2/crawl" -H "Content-Type: application/json" -d '{"url": "https://books.toscrape.com/", "limit": 20}'
```

- `limit` is how many pages to read, up to 100 (default 10).
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

**Mac / Linux:** the answer from Step 6b holds the first 10 pages, and near its start a `"next"` address. Put that address in place of `NEXT_ADDRESS`:
```bash
curl -s "NEXT_ADDRESS"
```
Keep doing the same with the `"next"` address in each new answer until it says `"next":null`. To save each batch, add `-o crawl1.json`, `-o crawl2.json` and so on to the end of the command.

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
| `RENDER_BUSY` | The page needs JavaScript and the free browser is busy (it reads one such page every 10 seconds) | Try again in a few seconds. Crawls retry these pages by themselves |
| `RENDER_BUDGET_EXHAUSTED` | The page needs JavaScript and today's free browser time is used up | Try again after midnight UTC |
| `EXTRACT_BUDGET_EXHAUSTED` | Today's free AI budget (Step 5) is used up | Try again after midnight UTC |
| `EXTRACT_FAILED` | The AI couldn't find all the fields you asked for | Use fields that really appear on the page, or add a `prompt` |
| `NOT_FOUND` | That crawl is older than 24 hours, or that saved setup was removed or unused for 30 days | Start a new crawl, or save the setup again |
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
| Reading pages, including running saved setups | 20 per minute |
| Pulling out facts (Step 5) | 20 per 24 hours; answers saved from the last hour don't count |
| Crawls / whole-website reads (Step 6) | 5 per 24 hours, up to 100 pages each |
| Saving new setups | 20 per 24 hours |

The 24 hours start with your first request, not at midnight. For example, if your first crawl is at 9:00 and you use all 5, you can crawl again at 9:00 the next day.

Asking for the same page again within an hour is answered instantly from memory.

---

## What Crawler Free will not do

It identifies itself honestly as `CrawlerFree`, always follows each site's `robots.txt` rules, and stops when a site says no. It can't log in, fill in forms, read pages behind a login, solve CAPTCHAs, or get past bot protection.

Questions, problems, or a site owner who wants to opt out: https://github.com/artthavv999/crawler-free/issues
