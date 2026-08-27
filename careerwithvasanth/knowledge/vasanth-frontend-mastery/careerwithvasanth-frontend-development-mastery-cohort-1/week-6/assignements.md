# Assignements

Source: https://app.notion.com/p/3071199ccfe380ef8f2cf34fbab27d1e

Time Duration: On an average each problem should be solve in 60-75 minutes.

## 1️⃣ Number Guessing Game with Attempts Tracker & Difficulty Levels

### 🎯 Objective

Build a game where the system generates a random number and the user tries to guess it within limited attempts.

---

### 🧩 Core Requirements

- System generates a random number.

- User inputs guesses.

- Show feedback:
  - “Too high”
  - “Too low”
  - “Correct”

- Track number of attempts.

- End game when:
  - Correct guess
  - Attempts exhausted

---

### 🎮 Difficulty Levels

Add selectable difficulty:

- Easy → 1–50 range (10 attempts)

- Medium → 1–100 range (7 attempts)

- Hard → 1–500 range (5 attempts)

Changing difficulty should reset game state.

---

## 2️⃣ Rock Paper Scissors with Scoreboard & Game History

### 🎯 Objective

Build a playable Rock-Paper-Scissors game against the computer.

---

### 🧩 Core Requirements

- User selects: Rock / Paper / Scissors

- Computer randomly selects one

- Determine winner using correct rules

- Show result: Win / Lose / Draw

- Maintain running score:
  - User score
  - Computer score

---

### 📜 Game History

Maintain and display:

- Last 5 rounds

- What user chose

- What computer chose

- Result

---

### 🔄 Additional Behavior

- Add “Reset Game” button

- Ensure score persists until reset

---

## 3️⃣ Whack-a-Mole Style Game with Random Target & Timer

### 🎯 Objective

Create a game where a target appears randomly and user must click it before it disappears.

---

### 🧩 Core Requirements

- Display a grid (e.g., 3×3).

- At any time, one random cell is “active”.

- Active cell changes every 800ms–1000ms.

- User clicks active cell → score increments.

- Clicking inactive cell → no score.

---

### ⏳ Game Timer

- Game runs for 30 seconds.

- After timer ends:
  - Disable interaction
  - Show final score

---

### 🔄 Controls

- Start Game

- Restart Game

---

## 4️⃣ Simple Quiz Game with Timer, Score & Progress Tracker

### 🎯 Objective

Build a quiz game that shows questions one by one and tracks user score.

---

### 🧩 Core Requirements

- Predefined array of questions.

- Each question has:
  - Question text
  - 4 options
  - Correct answer

- Show one question at a time.

- User selects one option.

- After answer:
  - Show correct/incorrect
  - Move to next question

---

### ⏳ Timer Per Question

- Each question has 10 seconds.

- If timer expires:
  - Auto move to next question
  - No score added

---

### 📊 Progress Tracking

- Show:
  - Question number
  - Total questions
  - Current score

---

### 🏁 End State

- Show final score

- Show “Restart Quiz”
