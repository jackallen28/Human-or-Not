<p align="center">
  <img src="docs/screenshots/overview-title.png" alt="The end-of-activity overview: EDU3001 vs the machine" width="100%">
</p>

<h1 align="center">Human or Not?</h1>

<p align="center"><b>A classroom Turing test that learns your class — and then shows them how it did it.</b></p>

<p align="center">
  Free to host on Render · Your own Claude API key · No coding · Years 9–12 or preservice teachers
</p>

---

Your students chat for three minutes with *someone*. A classmate across the room — or Claude,
pretending to be one. Then they guess.

Here's the twist: **after every round, Claude Opus reads every conversation**, works out what
gave the AI away, and quietly teaches it to do better. Round 1 it's polite, curious and easy to
catch. By round 3 it's complaining about the TPA, admitting it zoned out in the lecture, and
playing along with your class's in-jokes.

Then, if you choose, a fourth round with Opus switched off. **Nobody tells the students.**

<p align="center">
  <img src="docs/screenshots/overview-chart.png" alt="Pass rate by round: 25%, 50%, 75%, then 50% with Opus off" width="100%">
  <br><sub><i>A tutorial of eight. In round 1 the AI fooled one in four of the students who chatted with it — by round 3, three in four.</i></sub>
</p>

It's the most memorable way we know to start a conversation about AI, authorship and
assessment — because the evidence is the students' own chats.

---

## What a lesson looks like

### Before class — train it on *your* students

Download three short templates, fill them in with any AI tool and your unit plan, and upload.
Opus reads them, writes the brief every AI "classmate" works from, and tells you exactly what
would make it harder to catch.

<p align="center"><img src="docs/screenshots/train.png" alt="Training the AI on the class context" width="90%"></p>

### Pick who the AI pretends to be

Two persona sets written for real Australian classrooms. Untick anyone you don't want.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/personas-secondary.png" alt="Years 9–12 personas"><br><b>Years 9–12</b> — the ATAR grinder, the checked-out one, the class clown, the quiet thinker, the confident arguer, the distracted multitasker, the VET kid.</td>
    <td width="50%"><img src="docs/screenshots/personas-preservice.png" alt="Preservice teacher personas"><br><b>Preservice teachers (20–30)</b> — the career changer, the prac survivor, the theory enthusiast, the anxious perfectionist, the laid-back one, the critical sceptic, the early adopter.</td>
  </tr>
</table>

### Print the login cards

Name the class, say how many students — get a PDF of cut-out cards. No accounts, no emails,
no names on screen.

<p align="center"><img src="docs/screenshots/login-cards.png" alt="Printable login cards" width="55%"></p>

### Choose how to play

<p align="center"><img src="docs/screenshots/activity-modes.png" alt="Choosing a mode when starting an activity" width="90%"></p>

| Mode | Rounds | Learning? | Models |
|---|---|---|---|
| **Three rounds, learning** | 3 | Opus teaches the AI after every round | Haiku, Sonnet and Opus every round |
| **Four rounds, learning, then a switch** | 4 | After rounds 1–3 | All three in rounds 1–3; round 4 uses the models you pick (Opus off by default). Students aren't told. |
| **Open play** | A block of 1–6 at a time, then *keep going* (up to 12) | None. The AI works from the class brief every round | You choose the models for every round, between rounds |

Open play is the quick one: no analysis, so it's fast and cheap. It's also a fair test of
the models side by side, because nothing changes between rounds except the models you pick.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/open-play-results.png" alt="Open play: choosing the models for the next round"><br><sub>Open play: pick the models for the next round right on the results screen.</sub></td>
    <td width="50%"><img src="docs/screenshots/open-play-keep-going.png" alt="Open play: keep going or show the overview"><br><sub>End of a block: play more rounds, or show the overview.</sub></td>
  </tr>
</table>

### In class — project the console, hand out the cards

<p align="center"><img src="docs/screenshots/lobby.png" alt="The lobby filling up as students join" width="90%"></p>

Students type their code on their phone, read a four-sentence notice, and wait. Press start.

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/student-join.png" alt="Student joins with a code" width="230"><br><sub>Join with a code</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/student-chat.png" alt="Chatting — is this a classmate?" width="230"><br><sub>Chat… with whom?</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/student-result.png" alt="The reveal" width="230"><br><sub>Guess, then the reveal</sub></td>
  </tr>
</table>

<sub>That chat on the left? The grey bubbles are Claude, in round 2, already sounding like someone who survived prac.</sub>

<p align="center"><img src="docs/screenshots/live-round.png" alt="The live round on the projector" width="90%"></p>

### After each round — the class sees what gave it away

<p align="center"><img src="docs/screenshots/results.png" alt="Round results and Opus's analysis" width="90%"></p>

While you talk through the results, Opus writes up the AI's tells, the strategies students
used, what they were interested in — and the new instructions the AI gets for next round.
Students start adapting too. It becomes an arms race, and they can see it.

### The finale — an animated story of your class vs the machine

After the last round, Opus writes a one-off presentation of the whole activity. Same design every
time; every word written for *this* class.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/overview-story.png" alt="How it learned — the story"></td>
    <td width="50%"><img src="docs/screenshots/overview-opus.png" alt="What happened when Opus was switched off"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/overview-models.png" alt="Pass rate by model"></td>
    <td width="50%"><img src="docs/screenshots/overview-learning.png" alt="What the AI learned"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/overview-quotes.png" alt="Quotes from the chats"></td>
    <td width="50%"><img src="docs/screenshots/overview-findings.png" alt="Key findings"></td>
  </tr>
</table>

### Afterwards — keep everything

One click downloads a ZIP: a printable report, the animated overview (works offline), every
transcript, CSVs for your own analysis, and what Opus learned. What the AI learned also
carries into your next class, so it starts smarter every time.

---

## Why educators use it

- **It's about them.** The AI isn't generic — it's trained on their unit, their in-jokes, their way of writing.
- **The learning is visible.** Students watch the AI get better *because of what they did*.
- **The model switch is a lesson on its own.** Does the "best" model matter, or does context matter more?
- **Three ways to play.** Learning over three rounds, a secret model switch in round 4, or open play for as long as the class wants.
- **It's honest.** Students are told up front an AI might be involved. No personal details, ever. If anyone is distressed, the AI drops the act and points them to you.
- **It costs almost nothing.** Free hosting; a few US dollars of API credit for a class of 25.

<p align="center"><img src="docs/screenshots/console-home.png" alt="The teacher console home page" width="90%"><br><sub>The teacher console walks you through it in four steps.</sub></p>

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

## The detail

Everything above, step by step.

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
length and a mode (see *Choose how to play* above), and press **Start**. Project the console. Students go to your Render address, type
their code, read a four-sentence notice, and wait.

### 4 · The rounds

The default, **four rounds, learning, then a switch**:

| Round | AI partners | What they know |
|---|---|---|
| 1 | Haiku, Sonnet, Opus | Your class brief |
| 2 | Haiku, Sonnet, Opus | + what Opus learned from round 1 |
| 3 | Haiku, Sonnet, Opus | + what Opus learned from rounds 1–2 |
| 4 | Haiku, Sonnet (or whichever models you pick) | Opus switched off. **Students are not told.** |

**Three rounds, learning** is rounds 1–3 on their own. In **open play** every round works
from the class brief alone, with the models you pick. Opus does not analyse the rounds, and
you add more rounds a block at a time.

Each round: students are paired at random — about half with a classmate, half with the AI,
which models shared evenly — they chat until the clock runs out, then guess. Results appear
as soon as everyone has guessed (or when you press *Show results*). While you talk through
them, in the learning modes, **Claude Opus reads every conversation** and writes what gave the AI away, how
students tried to catch it, what they were interested in, and new instructions for the next
round. All of it is shown on screen and saved.

After the last round, Opus writes an **animated overview** of the whole activity: the pass
rate round by round and model by model, what the AI learned (in the learning modes), the
story of the activity, what the model switch or the model mix did, quotes from the chats, findings and discussion
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
| `report.html` | Start here: every round, all findings, every transcript. Prints to PDF. |
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
guide, a class of 25 across four learning rounds uses a few US dollars of API credit — most of it
Opus, which thinks hardest. Smaller classes and shorter rounds cost less, and open play skips the analysis entirely. Check
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
analysis, then the three-round and open-play modes, the overview, the download, backup and restore — against a stand-in for the
Claude API, so no key or credit is needed.

The screenshots in `docs/screenshots` are produced the same way — a full demo activity
against a stand-in API, driven in a headless browser:

```bash
node test/screenshots.mjs
```

## How it is built

```
server/
  index.js      web server, teacher API, live websocket
  activity.js   the round engine: pairing, chat, guesses, results
  modes.js      the three ways to play and their round plans
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
