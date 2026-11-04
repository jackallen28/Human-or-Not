# Human or Not?

**A classroom Turing test that learns your class.** Students chat for a few minutes with
someone — a classmate, or Claude pretending to be one — and then guess which. Over four
rounds the AI studies your students and gets harder to catch. At the end, an animated
overview shows the class how it learned, and what happened when its most capable model
was quietly switched off.

Built for any educator: secondary classes (Years 9–12) or preservice teachers. No coding.
It runs on Render's free plan with your own Claude API key.

---

## Set it up (about 10 minutes, once)

You need two things: a [Render](https://render.com) account (free) and a
[Claude API key](https://console.anthropic.com) (pay-as-you-go — see *What it costs*).

1. **Get a Claude API key.** At [console.anthropic.com](https://console.anthropic.com), add a
   little credit, then *API keys → Create key*. Copy it. While you are there, set a monthly
   spend limit under *Limits* — it is good practice.
2. **Put this project on Render.** Fork this repository to your own GitHub account, then in
   Render choose **New → Blueprint** and pick your fork. Render reads `render.yaml` and sets
   up the website and a free database for you.
3. **Fill in the two secrets Render asks for:**
   - `ANTHROPIC_API_KEY` — the key from step 1.
   - `TEACHER_CODE` — any code you like. You type it to open the teacher console; students
     never need it.
4. **Wait for the first deploy** (3–5 minutes). Render gives you an address like
   `https://human-or-not-xxxx.onrender.com`. Students go to that address;
   you go to that address followed by **`/teacher`**.

That is the whole set-up. Updates you push to your fork deploy automatically.

---

## Using it

The teacher console walks you through four steps.

### 1 · Train the AI on your class

Download the three context files — **01 About the class**, **02 What we've learned**,
**03 Student voice** — and open them in Claude, ChatGPT or any AI tool together with your
unit plan. The console gives you a prompt to paste. Upload the completed files and press
**Train the AI**.

Claude Opus reads them and writes the brief every AI chat partner works from, then tells you
what is missing (*"Add ten real example messages"*). **The more context you give, the harder
the AI is to catch** — file 03, real (paraphrased) student writing, matters most of all.

> "Training" here means the AI is *given* your context before every chat. The Claude
> models themselves are not retrained, and nothing you upload is used to train them.

### 2 · Set up a class

Give the class a name, the number of students, the context from step 1, and choose who
the AI pretends to be:

- **Secondary students (Years 9–12)** — the ATAR grinder, the checked-out one, the class
  clown, the quiet thinker, the confident arguer, the distracted multitasker, the VET kid.
- **Preservice teachers (ITE, 20–30)** — the career changer, the prac survivor, the theory
  enthusiast, the anxious perfectionist, the laid-back one, the critical sceptic, the
  tech-savvy early adopter.

Untick any persona you do not want. The console downloads a **PDF of login cards** —
*Student 1 · BAKE2739* — ten to a page, ready to print and cut. Codes avoid I, O, 0 and 1
so they can be read aloud.

### 3 · Start an activity

Pick the class, name the activity (e.g. *"Preservice teachers — week 6"*), choose a round
length, and press **Start**. Project the console. Students go to your Render address, type
their code, read a four-sentence notice, and wait.

### 4 · Four rounds

| Round | AI partners | What they know |
|---|---|---|
| 1 | Haiku, Sonnet, Opus | Your class brief |
| 2 | Haiku, Sonnet, Opus | + what Opus learned from round 1 |
| 3 | Haiku, Sonnet, Opus | + what Opus learned from rounds 1–2 |
| 4 | Haiku, Sonnet | Opus switched off. **Students are not told.** |

Each round: students are paired at random — about half with a classmate, half with the AI,
which models shared evenly — they chat until the clock runs out, then guess. Results appear
as soon as everyone has guessed (or when you press *Show results*). While you talk through
them, **Claude Opus reads every conversation** and writes what gave the AI away, how
students tried to catch it, what they were interested in, and new instructions for the next
round. All of it is shown on screen and saved.

After round 4, Opus writes an **animated overview** of the whole activity: the pass rate
round by round and model by model, what the AI learned, the story of how it adapted to this
class, the effect of switching Opus off, quotes from the chats, findings and discussion
questions. Same presentation every time; its content is written fresh for each class.

What an activity learns is also saved to the class context, so the **next** activity with
that context starts from where this one finished.

### What students see

Before they join:

> You'll chat with someone for a few minutes — it might be a classmate, or it might be
> generative AI pretending to be one. Either way, don't share personal information like
> your full name, address, phone number or socials. Be respectful, as you would in class.
> At the end you'll guess: human or AI?

Then a chat window with a countdown, two buttons to guess, and whether they were right.

---

## The download

**Download all activity data (ZIP)** — from the live view or any time later under
*Activities* — gives you:

| | |
|---|---|
| `report.html` | Start here: the four rounds, all findings, every transcript. Prints to PDF. |
| `overview/overview.html` | The animated overview. Opens offline in any browser — show it again, share it. |
| `overview/overview.json` | The overview content Opus wrote, as data. |
| `analysis/round-N.md` / `.json` | What Opus found after each round and the guidance it gave the AI. |
| `data/messages.csv` | Every message: round, conversation, model, persona, speaker, time, text. |
| `data/results.csv` | One row per student per round: partner, model, persona, guess, correct. |
| `data/rounds.csv` | One row per round: the headline numbers, overall and per model. |
| `data/transcripts.txt` | Every conversation, readable. |
| `data/activity.json` | Everything above in one file. |
| `context/` | The context files and the brief the AI worked from. |

Students appear as *Student 1, Student 2…*. Login codes are never included.

---

## Things worth knowing

**Free hosting sleeps.** A free Render service goes to sleep after 15 minutes with no
visitors and takes about a minute to wake. **Open the teacher console five minutes before
class.** While the console is open it keeps the service awake.

**Your data.** The blueprint adds a free Render Postgres database, which keeps your
contexts, classes and activities when the service sleeps. Render's free databases
**expire after 30 days**: use **Back up everything** on the console's Home page
(one file, restores with one click), or upgrade the database in Render to keep it
permanently. Without a database the console warns you that nothing is being kept.

**What it costs.** You pay Anthropic for what the AI uses; Render is free. As a rough
guide, a class of 25 across four rounds uses a few US dollars of API credit — most of it
Opus, which thinks hardest. Smaller classes and shorter rounds cost less. Check
*Usage* in the Anthropic console after your first run, and set a spend limit.

**Models.** The console uses the newest Haiku, Sonnet and Opus your API key can access,
found automatically each time the service starts. Effort is medium for Haiku and Sonnet and
high for Opus. To pin a model, set `MODEL_HAIKU`, `MODEL_SONNET` or `MODEL_OPUS` in Render.

**Privacy and safety.** Conversations are sent to the Claude API to generate replies and
the analysis. Check your school or university's policy on using AI tools with students,
and tell students what is recorded — the notice above does. The AI never asks for personal
details, and if a student raises distress or asks sincerely to stop, it drops the act and
tells them to speak to their teacher. Anthropic's API is not used to train models on your
data by default.

**One activity at a time.** The server runs one live activity at a time. Run another class
afterwards, or deploy a second copy.

---

## Running it on your own computer

```bash
npm install
cp .env.example .env     # add your ANTHROPIC_API_KEY and TEACHER_CODE
npm start                # http://localhost:3000 and http://localhost:3000/teacher
```

Students on the same Wi-Fi join at your computer's local address (e.g.
`http://192.168.1.20:3000`). Data is kept in `./data`.

## Tests

```bash
npm test
```

Runs unit checks, then a complete activity — training, a class, four rounds with
analysis, the overview, the download, backup and restore — against a stand-in for the
Claude API, so no key or credit is needed.

## How it is built

```
server/
  index.js      web server, teacher API, live websocket
  activity.js   the four-round engine: pairing, chat, guesses, results
  bot.js        the AI classmate: briefing, rules, pacing
  analysis.js   Opus: training, per-round analysis, the overview story
  claude.js     model discovery, effort, the API wrapper
  personas.js   the two persona sets
  text.js       reply length, trimming, openers
  pdf.js        login codes and the printable cards
  report.js     the report, CSVs, standalone overview, the ZIP
  store.js      Postgres or files
templates/      the three context files educators download
public/         the student page, the teacher console, the overview
```

---

<p align="center">Powered and created by <a href="https://www.allentronics.com.au">Allentronics Education Services</a></p>
