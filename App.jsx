import { useState, useEffect, useRef, useCallback } from "react";
import { sGet, sSet, sList, loadRoster, subscribeKey, subscribePrefix } from "./storage.js";

/* ------------------------------------------------------------------ */
/*  HORSE RACE — multiplayer card drinking game (Quiplash-style join)  */
/* ------------------------------------------------------------------ */

const TRACK_LEN = 6;

const SUITS = {
  S: { sym: "♠", name: "Spades", red: false },
  H: { sym: "♥", name: "Hearts", red: true },
  D: { sym: "♦", name: "Diamonds", red: true },
  C: { sym: "♣", name: "Clubs", red: false },
};
const SUIT_KEYS = ["S", "H", "D", "C"];

const C = {
  turf: "#0C4A2F",
  turfDeep: "#07301E",
  rail: "#0F5C3B",
  chalk: "#F4EFDF",
  chalkDim: "#C9C2AC",
  tote: "#F0C24B",
  red: "#E05252",
  ink: "#131009",
  card: "#FBF7EA",
};


/* ---------------- sound + haptics ---------------- */

const sfx = (() => {
  let ctx = null;
  let enabled = true;
  const ensure = () => {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
    }
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };
  const tone = (freq, dur = 0.08, type = "square", gain = 0.05, delay = 0) => {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  };
  const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* no haptics */ } };
  return {
    setEnabled(v) { enabled = v; if (v) ensure(); },
    isEnabled() { return enabled; },
    unlock: ensure,
    draw() { tone(190, 0.05, "square", 0.04); tone(255, 0.05, "square", 0.04, 0.07); buzz(20); },
    flip() { tone(330, 0.12, "sawtooth", 0.05); tone(220, 0.16, "sawtooth", 0.05, 0.1); tone(147, 0.24, "sawtooth", 0.05, 0.2); buzz([70, 40, 70]); },
    everyone() { tone(880, 0.09, "square", 0.05, 0.35); tone(880, 0.09, "square", 0.05, 0.48); tone(1175, 0.14, "square", 0.05, 0.62); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, "triangle", 0.06, i * 0.12)); buzz([60, 40, 60, 40, 140]); },
    lose() { tone(196, 0.2, "triangle", 0.05); tone(147, 0.32, "triangle", 0.05, 0.18); buzz(90); },
    sent() { tone(660, 0.08, "triangle", 0.05); tone(880, 0.1, "triangle", 0.05, 0.09); },
    tick() { tone(1046, 0.06, "square", 0.05); buzz(15); },
  };
})();

/**
 * Watches room state and fires draw / flip / everyone-drinks / result sounds.
 * myWin: true → win fanfare at results, false → sad trombone,
 * "spect" → fanfare (host & big screen), null → silent at results.
 */
function useRaceSfx(room, myWin = "spect") {
  const prev = useRef({ draw: -1, flipped: -1, phase: null, roundId: null });
  useEffect(() => {
    if (!room) return;
    const rd = room.round;
    const p = prev.current;
    if (p.roundId !== rd.roundId) {
      prev.current = { draw: rd.drawIdx, flipped: rd.flipped, phase: room.phase, roundId: rd.roundId };
      return;
    }
    if (room.phase === "race" && rd.drawIdx > p.draw) {
      sfx.draw();
      if (rd.flipped > p.flipped) {
        // the flip happens visually after the forward gallop — match the sound to it
        const flipDrink = room.rules?.flipDrink;
        setTimeout(() => {
          sfx.flip();
          if (flipDrink) sfx.everyone();
        }, 1400);
      }
    }
    if (room.phase === "results" && p.phase !== "results") {
      if (myWin === true) sfx.win();
      else if (myWin === false) sfx.lose();
      else if (myWin === "spect") sfx.win();
    }
    prev.current = { draw: rd.drawIdx, flipped: rd.flipped, phase: room.phase, roundId: rd.roundId };
  }, [room, myWin]);
}

function SoundToggle() {
  const [on, setOn] = useState(sfx.isEnabled());
  return (
    <button
      aria-label={on ? "Mute sound" : "Unmute sound"}
      onClick={() => { sfx.setEnabled(!on); setOn(!on); }}
      style={{
        position: "fixed", top: 10, right: 10, zIndex: 50,
        width: 42, height: 42, borderRadius: "50%",
        background: C.turf, border: `2px solid ${C.rail}`, color: C.chalk,
        fontSize: 18, cursor: "pointer",
      }}
    >
      {on ? "🔊" : "🔇"}
    </button>
  );
}

/* ---------------- game helpers ---------------- */

// crypto-grade randomness when available, unbiased via rejection sampling
function randInt(n) {
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    let x;
    do { window.crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % n;
  }
  return Math.floor(Math.random() * n);
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
// 48 real cards: 2 through King of each suit (the four aces are the horses).
// Cards are stored as strings like "7C" or "10H" — suit is the last character.
function makeDeck() {
  const d = [];
  SUIT_KEYS.forEach((s) => RANKS.forEach((r) => d.push(`${r}${s}`)));
  return shuffle(d);
}
function makeCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ";
  let c = "";
  for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}
function slug(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "player";
}
function freshRound(roundId) {
  // ONE real 48-card deck (52 minus the four ace horses), just like the table game:
  // the 6 track cards are dealt face-down off the top, and the remaining 42 cards
  // form the draw pile. Every card that leaves the deck — dealt to the track or
  // drawn during the race — depletes the same suit counts. E.g. if the first draw
  // is a club, only 11 clubs remain across the draw pile and unrevealed track.
  const deck = makeDeck();
  const trackSuits = deck.slice(0, TRACK_LEN);
  return {
    roundId,
    deck: deck.slice(TRACK_LEN),
    trackSuits,
    positions: { S: 0, H: 0, D: 0, C: 0 },
    flipped: 0,
    drawIdx: 0,
    lastCard: null,
    lastFlip: null,
    winner: null,
    pendingAt: null,
  };
}
const roomKey = (code) => `hr:${code}:room`;
const playerKey = (code, id) => `hr:${code}:p:${id}`;

// sips sent TO pid by other players this round
function incomingFor(pid, roster, roundId) {
  return roster
    .filter((q) => q.id !== pid && q.givesRound === roundId && q.gives && q.gives[pid] > 0)
    .map((q) => ({ from: q.name, n: q.gives[pid] }));
}

/* ---------------- shared visual pieces ---------------- */

function Styles() {
  return (
    <style>{`
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
      @keyframes slidein { from{transform:translateY(8px);opacity:0} to{transform:translateY(0);opacity:1} }
      @keyframes shout { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }
      @keyframes countpop { 0%{transform:scale(1.7);opacity:0} 30%{opacity:1} 100%{transform:scale(1);opacity:1} }
      @keyframes hlegF { 0%,100%{transform:rotate(24deg)} 50%{transform:rotate(-26deg)} }
      @keyframes hlegB { 0%,100%{transform:rotate(-24deg)} 50%{transform:rotate(26deg)} }
      @keyframes hbob { 0%,100%{transform:translateY(0) rotate(-1deg)} 50%{transform:translateY(-2.5px) rotate(1.5deg)} }
      @keyframes hstumble { 0%{transform:rotate(0)} 30%{transform:rotate(-12deg) translateY(3px)} 60%{transform:rotate(6deg)} 100%{transform:rotate(0)} }
      @keyframes hrear { 0%,100%{transform:rotate(0)} 40%{transform:rotate(-14deg) translateY(-2px)} 70%{transform:rotate(-10deg)} }
      .hleg{transform-box:fill-box;transform-origin:50% 4%}
      .hleg-f1{animation:hlegF .45s linear infinite}
      .hleg-f2{animation:hlegF .45s linear infinite .1s}
      .hleg-b1{animation:hlegB .45s linear infinite .05s}
      .hleg-b2{animation:hlegB .45s linear infinite .16s}
      .hbody-run{animation:hbob .45s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
      .hstumble{animation:hstumble .7s ease}
      .hwin{animation:hrear 1.4s ease;transform-box:fill-box;transform-origin:30% 90%}
      .hr-root{min-height:100vh;background:${C.turfDeep};color:${C.chalk};font-family:ui-rounded,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
      .hr-wrap{max-width:520px;margin:0 auto;padding:20px 16px 48px}
      .hr-bigwrap{max-width:1600px;margin:0 auto;padding:24px 24px 48px}
      .hr-biggrid{display:grid;grid-template-columns:1fr;gap:20px}
      @media(min-width:900px){ .hr-biggrid{grid-template-columns:1fr 280px;align-items:start} }
      .hr-display{font-family:Haettenschweiler,'Arial Narrow','Franklin Gothic Medium',Impact,sans-serif;letter-spacing:.04em;text-transform:uppercase}
      .hr-btn{display:block;width:100%;border:none;border-radius:14px;padding:16px;font-size:18px;font-weight:800;cursor:pointer;font-family:inherit;transition:transform .08s}
      .hr-btn:active{transform:scale(.97)}
      .hr-btn:focus-visible{outline:3px solid ${C.tote};outline-offset:2px}
      .hr-btn:disabled{opacity:.45;cursor:default}
      .hr-input{width:100%;box-sizing:border-box;border-radius:12px;border:2px solid ${C.rail};background:${C.turf};color:${C.chalk};padding:14px;font-size:18px;font-family:inherit}
      .hr-input:focus{outline:2px solid ${C.tote};border-color:${C.tote}}
      .hr-input::placeholder{color:${C.chalkDim}}
      .hr-chip{animation:slidein .25s ease}
      .hr-shout{animation:shout .5s ease-in-out infinite}
      @media (prefers-reduced-motion: reduce){ *{animation:none !important;transition:none !important} }
    `}</style>
  );
}

function SuitFace({ s, size = 26 }) {
  return (
    <span style={{ color: SUITS[s].red ? C.red : C.ink, fontSize: size, lineHeight: 1 }}>
      {SUITS[s].sym}
    </span>
  );
}

function ToteHeader({ sub }) {
  return (
    <div style={{ textAlign: "center", marginBottom: 18 }}>
      <div className="hr-display" style={{ fontSize: 44, color: C.tote, lineHeight: 1 }}>
        Horse Race
      </div>
      <div style={{ color: C.chalkDim, fontSize: 13, letterSpacing: ".14em", textTransform: "uppercase", marginTop: 4 }}>
        {sub}
      </div>
    </div>
  );
}

/* ---------------- the horse (photo cutouts, facing the finish line) ---------------- */

const HORSE_IMGS = {
  S: "data:image/webp;base64,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",
  H: "data:image/webp;base64,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",
  D: "data:image/webp;base64,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",
  C: "data:image/webp;base64,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",
};

// the Clubs photo is a wider crop, so it renders smaller in the same cell — scale it up to match
const HORSE_SCALE = { S: 1, H: 1, D: 1, C: 1.18 };

function Horse({ s, galloping, stumble, won }) {
  const run = galloping && !won;
  const suitColor = SUITS[s].red ? C.red : C.ink;
  return (
    <div
      className={stumble ? "hstumble" : won ? "hwin" : run ? "hbody-run" : ""}
      style={{ position: "relative", width: "100%", height: "100%", animationDelay: stumble ? "1.8s" : undefined }}
      role="img" aria-label={`${SUITS[s].name} horse`}
    >
      <img
        src={HORSE_IMGS[s]} alt=""
        draggable={false}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none", userSelect: "none", transform: `scale(${HORSE_SCALE[s]})`, transformOrigin: "center" }}
      />
      {/* suit badge for readability at small track size */}
      <span style={{
        position: "absolute", top: 5, left: 4,
        width: 16, height: 16, borderRadius: "50%",
        background: C.card, border: "1px solid rgba(0,0,0,.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, lineHeight: 1, color: suitColor, fontWeight: 700,
        boxShadow: "0 1px 2px rgba(0,0,0,.4)",
      }}>{SUITS[s].sym}</span>
    </div>
  );
}

/* ---------------- the dealer's card (3-2-1 countdown, then flip) ---------------- */

function useCountdown(pendingAt) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    if (!pendingAt) { setCount(null); return; }
    const start = Date.now();
    const tick = () => {
      const remain = 3 - Math.floor((Date.now() - start) / 900);
      setCount(Math.max(remain, 0));
    };
    tick();
    const t = setInterval(tick, 150);
    return () => clearInterval(t);
  }, [pendingAt]);
  return count;
}

function DrawnCard({ round, big = false }) {
  const count = useCountdown(round.pendingAt);
  const cardStr = round.lastCard;
  const suit = cardStr ? cardStr.slice(-1) : null;
  const rank = cardStr ? cardStr.slice(0, -1) : "";
  const revealed = !round.pendingAt && !!cardStr;
  const w = big ? 150 : 104;
  const suitColor = suit && SUITS[suit].red ? C.red : C.ink;
  const face = {
    position: "absolute", inset: 0, borderRadius: 10,
    border: "1px solid rgba(0,0,0,.35)",
    backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
  return (
    <div style={{ width: w, flexShrink: 0 }}>
      <div style={{ fontSize: 11, color: C.chalkDim, textTransform: "uppercase", letterSpacing: ".12em", textAlign: "center", marginBottom: 6 }}>
        {round.pendingAt ? "Drawing…" : revealed ? "Last card" : "The deck"}
      </div>
      <div style={{ position: "relative", width: "100%", aspectRatio: "3/4", perspective: "420px" }}>
        <div style={{
          position: "relative", width: "100%", height: "100%",
          transformStyle: "preserve-3d",
          transition: "transform .55s cubic-bezier(.3,1.3,.4,1)",
          transform: revealed ? "rotateY(0deg)" : "rotateY(180deg)",
        }}>
          {/* front: the revealed card */}
          <div style={{ ...face, background: C.card }}>
            {suit && (
              <>
                <span style={{ position: "absolute", top: 6, left: 8, fontSize: big ? 20 : 15, fontWeight: 800, lineHeight: 1.05, color: suitColor, textAlign: "center" }}>
                  {rank}<br />{SUITS[suit].sym}
                </span>
                <span style={{ fontSize: big ? 58 : 40, color: suitColor, lineHeight: 1 }}>{SUITS[suit].sym}</span>
                <span style={{ position: "absolute", bottom: 6, right: 8, fontSize: big ? 20 : 15, fontWeight: 800, lineHeight: 1.05, color: suitColor, textAlign: "center", transform: "rotate(180deg)" }}>
                  {rank}<br />{SUITS[suit].sym}
                </span>
              </>
            )}
          </div>
          {/* back: card pattern */}
          <div style={{
            ...face,
            transform: "rotateY(180deg)",
            background: "repeating-linear-gradient(45deg,#28457A,#28457A 4px,#1D3560 4px,#1D3560 8px)",
          }} />
        </div>
        {/* 3-2-1 countdown overlay */}
        {round.pendingAt && (
          <div key={count} className="hr-display" style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: big ? 84 : 60, color: C.tote,
            textShadow: "0 2px 10px rgba(0,0,0,.65)",
            animation: "countpop .9s ease",
          }}>
            {count > 0 ? count : "…"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- the track ---------------- */

function Track({ round, racing, rules, big = false }) {
  if (!round) return null;
  const cols = TRACK_LEN + 2; // gate + 6 + finish
  const sz = big
    ? { pad: 20, tcSuit: 28, comm: 20, fin: 16, laneBg: 8 }
    : { pad: 12, tcSuit: 16, comm: 14, fin: 11, laneBg: 6 };
  const everyone = rules?.flipDrink && round.lastFlip && !round.winner;
  const cardFace = {
    position: "absolute", inset: 0, borderRadius: 6,
    border: "1px solid rgba(0,0,0,.35)",
    display: "flex", alignItems: "center", justifyContent: "center",
    backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden",
  };
  return (
    <div style={{
      background: C.turf, border: `2px solid ${C.rail}`, borderRadius: 16, padding: sz.pad,
      // on phone/host/player views the track breaks out of the narrow column
      // and spans most of the screen; big-screen mode manages its own layout
      ...(big ? {} : { width: "min(96vw, 900px)", marginLeft: "50%", transform: "translateX(-50%)", boxSizing: "border-box" }),
    }}>
      {everyone && (
        <div style={{ animation: "slidein .35s ease 1.5s both" }}>
          <div className="hr-display hr-shout" style={{
            background: C.tote, color: C.ink, textAlign: "center", borderRadius: 10,
            padding: big ? "12px 8px" : "7px 8px", fontSize: big ? 34 : 21, marginBottom: 12,
          }}>
            🍻 Everyone drinks!
          </div>
        </div>
      )}
      {/* face-down track cards: each flips (3D) once ALL four horses reach its column */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 4, marginBottom: 10 }}>
        <div />
        {round.trackSuits.map((cardStr, i) => {
          const s = cardStr.slice(-1);
          const rank = cardStr.slice(0, -1);
          const isFlipped = i < round.flipped;
          const justFlipped = isFlipped && i === round.flipped - 1 && !!round.lastFlip;
          return (
            <div key={i} style={{ aspectRatio: "3/4", perspective: "260px" }}>
              <div style={{
                position: "relative", width: "100%", height: "100%",
                transformStyle: "preserve-3d",
                transition: "transform .65s cubic-bezier(.3,1.3,.4,1)",
                // a card triggered this draw flips only after the drawn horse finishes galloping
                transitionDelay: justFlipped ? "1.4s" : "0s",
                transform: isFlipped ? "rotateY(0deg)" : "rotateY(180deg)",
              }}>
                {/* front: revealed card */}
                <div style={{ ...cardFace, background: C.card, flexDirection: "column" }}>
                  {rank && <span style={{ fontSize: Math.round(sz.tcSuit * 0.62), fontWeight: 800, lineHeight: 1.1, color: SUITS[s].red ? C.red : C.ink }}>{rank}</span>}
                  <SuitFace s={s} size={sz.tcSuit} />
                </div>
                {/* back: card pattern */}
                <div style={{
                  ...cardFace,
                  transform: "rotateY(180deg)",
                  background: "repeating-linear-gradient(45deg,#28457A,#28457A 3px,#1D3560 3px,#1D3560 6px)",
                }} />
              </div>
            </div>
          );
        })}
        <div className="hr-display" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: sz.fin, color: C.tote }}>
          Fin
        </div>
      </div>
      {/* lanes: horses stay mounted and glide between columns after the reveal */}
      {SUIT_KEYS.map((s) => {
        const pos = Math.min(round.positions[s], TRACK_LEN + 1);
        const won = round.winner === s;
        const stumbling = round.lastFlip === s && !round.winner;
        return (
          <div key={s} style={{
            position: "relative", padding: "5px 0",
            borderTop: `1px dashed ${C.rail}`,
            background: won ? "rgba(240,194,75,.14)" : "transparent", borderRadius: sz.laneBg,
          }}>
            {/* invisible cell establishes the lane height to match the card columns */}
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 4 }}>
              <div style={{ aspectRatio: "3/4" }} />
            </div>
            {/* gliding horse: waits a beat after the card flips, then gallops over */}
            <div style={{
              position: "absolute", top: "50%",
              left: `${(pos / cols) * 100}%`, width: `${100 / cols}%`, height: "100%",
              transform: "translateY(-50%)",
              transition: "left 1.1s cubic-bezier(.45,.05,.35,1)",
              // a knocked-back horse waits for the forward gallop + card flip, then retreats
              transitionDelay: stumbling ? "2.1s" : ".5s",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{
                width: "135%", height: "135%",
                filter: won
                  ? "drop-shadow(0 0 6px rgba(240,194,75,.95))"
                  : "drop-shadow(0 2px 3px rgba(0,0,0,.5))",
              }}>
                <Horse
                  key={stumbling ? `st-${round.drawIdx}` : "run"}
                  s={s}
                  galloping={racing && !round.winner}
                  stumble={stumbling}
                  won={won}
                />
              </div>
            </div>
          </div>
        );
      })}
      {/* commentary line */}
      <div style={{ marginTop: 10, minHeight: 20, textAlign: "center", fontSize: sz.comm, color: C.chalkDim }}>
        {round.winner ? (
          <b style={{ color: C.tote }}>{SUITS[round.winner].sym} {SUITS[round.winner].name} wins!</b>
        ) : round.lastFlip ? (
          <span>Track card flipped — {SUITS[round.lastFlip].sym} stumbles back!</span>
        ) : round.lastCard ? (
          <span>Drawn: <b style={{ color: C.chalk }}>{round.lastCard.slice(0, -1)}{SUITS[round.lastCard.slice(-1)].sym} {SUITS[round.lastCard.slice(-1)].name}</b> surges ahead</span>
        ) : racing ? (
          <span style={{ animation: "pulse 1.2s infinite" }}>Horses at the gate — waiting on the first card…</span>
        ) : (
          <span>Horses at the gate</span>
        )}
      </div>
    </div>
  );
}

/* ---------------- bet outcome math ---------------- */

function outcome(bet, winner) {
  if (!bet?.suit) return { label: "No bet — safe this round", give: 0, drink: 0 };
  if (bet.suit === winner) return { label: `Winner! Give out ${bet.drinks * 2} sips`, give: bet.drinks * 2, drink: 0 };
  return { label: `Drink ${bet.drinks} sips`, give: 0, drink: bet.drinks };
}

/* ================================================================ */
/*  HOST                                                            */
/* ================================================================ */

function HostView({ resumeCode, onExit }) {
  const [code, setCode] = useState(resumeCode || null);
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [err, setErr] = useState("");
  const [drawing, setDrawing] = useState(false);
  const roomRef = useRef(null);
  roomRef.current = room;

  useRaceSfx(room);

  const writeRoom = useCallback(async (r) => {
    setRoom(r);
    roomRef.current = r;
    await sSet(roomKey(r.code), r);
  }, []);

  // create or resume
  useEffect(() => {
    (async () => {
      if (resumeCode) {
        const r = await sGet(roomKey(resumeCode));
        if (!r) { setErr("No race found with that code."); return; }
        setCode(resumeCode); setRoom(r);
      } else {
        const c = makeCode();
        const r = { code: c, phase: "lobby", rules: { flipDrink: false }, round: freshRound(1), createdAt: Date.now() };
        setCode(c);
        await writeRoom(r);
      }
    })();
  }, [resumeCode, writeRoom]);

  // poll players
  useEffect(() => {
    if (!code) return;
    let live = true;
    const load = async () => {
      const ps = await loadRoster(code);
      if (live) setPlayers(ps);
    };
    load();
    const unsub = subscribePrefix(`hr:${code}:p:`, load);
    const t = setInterval(load, 8000); // realtime does the work; poll is a safety net
    return () => { live = false; unsub(); clearInterval(t); };
  }, [code]);

  // one manual card draw: arm a 3-2-1 countdown on every screen, then reveal
  const drawCard = async () => {
    const r = roomRef.current;
    if (!r || r.phase !== "race" || drawing) return;
    setDrawing(true);
    try {
      await writeRoom({ ...r, round: { ...r.round, pendingAt: Date.now() } });
      for (let i = 3; i >= 1; i--) {
        sfx.tick();
        await new Promise((res) => setTimeout(res, 900));
      }
      const r2 = roomRef.current;
      if (!r2 || r2.phase !== "race") return;
      const rd = { ...r2.round, positions: { ...r2.round.positions } };
      rd.pendingAt = null;
      const drawn = rd.deck[rd.drawIdx];
      if (!drawn) return; // can't happen: a winner is guaranteed before the pile empties
      const suit = drawn.slice(-1);
      rd.drawIdx += 1;
      rd.lastCard = drawn;
      rd.lastFlip = null;
      rd.positions[suit] += 1;
      if (rd.positions[suit] > TRACK_LEN) {
        rd.winner = suit;
        await writeRoom({ ...r2, phase: "results", round: rd });
        return;
      }
      // flip rule: once ALL four horses have reached the next face-down card's
      // position, that card flips and its suit falls back one space
      while (rd.flipped < TRACK_LEN && Math.min(...SUIT_KEYS.map((s) => rd.positions[s])) >= rd.flipped + 1) {
        const f = rd.trackSuits[rd.flipped].slice(-1);
        rd.positions[f] = Math.max(0, rd.positions[f] - 1);
        rd.flipped += 1;
        rd.lastFlip = f;
      }
      await writeRoom({ ...r2, round: rd });
    } finally {
      setDrawing(false);
    }
  };

  if (err) return (
    <div className="hr-wrap">
      <ToteHeader sub="Host" />
      <p style={{ textAlign: "center" }}>{err}</p>
      <button className="hr-btn" style={{ background: C.tote, color: C.ink }} onClick={onExit}>Back</button>
    </div>
  );
  if (!room) return <div className="hr-wrap" style={{ textAlign: "center", paddingTop: 80 }}>Setting up the track…</div>;

  const currentBets = players.filter((p) => p.roundId === room.round.roundId && p.suit);
  const betCount = currentBets.length;
  const flipDrink = !!room.rules?.flipDrink;

  return (
    <div className="hr-wrap">
      <ToteHeader sub={room.phase === "lobby" ? "Waiting for riders" : room.phase === "betting" ? "Bets open" : room.phase === "race" ? "You're the dealer" : "Results"} />

      {/* room code banner */}
      <div style={{ background: C.tote, color: C.ink, borderRadius: 14, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontWeight: 800, fontSize: 13, textTransform: "uppercase", letterSpacing: ".1em" }}>Join code</span>
        <span className="hr-display" style={{ fontSize: 34, letterSpacing: ".18em" }}>{room.code}</span>
      </div>

      {(room.phase === "lobby" || room.phase === "betting") && (
        <>
          <Track round={room.round} racing={false} rules={room.rules} />

          {/* house rule toggle */}
          <button
            onClick={() => writeRoom({ ...room, rules: { ...room.rules, flipDrink: !flipDrink } })}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
              width: "100%", boxSizing: "border-box", marginTop: 12,
              background: flipDrink ? "rgba(240,194,75,.15)" : C.turf,
              border: `2px solid ${flipDrink ? C.tote : C.rail}`, borderRadius: 12,
              padding: "12px 14px", color: C.chalk, fontFamily: "inherit", fontSize: 14, textAlign: "left", cursor: "pointer",
            }}
          >
            <span>🍻 House rule: everyone drinks when a track card flips</span>
            <span className="hr-display" style={{
              background: flipDrink ? C.tote : C.turfDeep, color: flipDrink ? C.ink : C.chalkDim,
              borderRadius: 8, padding: "3px 10px", fontSize: 15,
            }}>
              {flipDrink ? "On" : "Off"}
            </span>
          </button>

          <div style={{ margin: "16px 0" }}>
            <div style={{ fontSize: 13, color: C.chalkDim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
              {players.length} rider{players.length !== 1 ? "s" : ""} in · {betCount} bet{betCount !== 1 ? "s" : ""} placed
            </div>
            {players.map((p) => {
              const hasBet = p.roundId === room.round.roundId && p.suit;
              return (
                <div key={p.id} className="hr-chip" style={{ display: "flex", justifyContent: "space-between", background: C.turf, border: `1px solid ${C.rail}`, borderRadius: 10, padding: "10px 14px", marginBottom: 6 }}>
                  <b>{p.name}</b>
                  <span style={{ color: hasBet ? C.tote : C.chalkDim }}>
                    {hasBet ? <>{SUITS[p.suit].sym} · {p.drinks} sips</> : "deciding…"}
                  </span>
                </div>
              );
            })}
            {players.length === 0 && <div style={{ color: C.chalkDim, fontStyle: "italic" }}>Tell everyone to open this app and enter the code.</div>}
          </div>
          {room.phase === "lobby" ? (
            <button className="hr-btn" style={{ background: C.tote, color: C.ink }} disabled={players.length === 0}
              onClick={() => writeRoom({ ...room, phase: "betting" })}>
              Open betting
            </button>
          ) : (
            <button className="hr-btn" style={{ background: C.red, color: C.chalk }} disabled={betCount === 0}
              onClick={() => writeRoom({ ...room, phase: "race" })}>
              To the gates 🏇
            </button>
          )}
          <p style={{ color: C.chalkDim, fontSize: 12, textAlign: "center", marginTop: 14, lineHeight: 1.5 }}>
            Got a TV or laptop nearby? Open this app on it and choose “Watch on a big screen” with code {room.code}.
          </p>
        </>
      )}

      {room.phase === "race" && (
        <>
          <Track round={room.round} racing rules={room.rules} />
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 14 }}>
            <DrawnCard round={room.round} />
            <div style={{ flex: 1 }}>
              <button className="hr-btn" style={{ background: C.red, color: C.chalk, fontSize: 22, padding: "20px 16px" }}
                disabled={drawing} onClick={drawCard}>
                🎴 Draw a card
              </button>
              <div style={{ textAlign: "center", color: C.chalkDim, fontSize: 13, marginTop: 8 }}>
                {room.round.drawIdx === 0
                  ? "Tap to draw — you set the pace."
                  : `${room.round.drawIdx} drawn · ${room.round.deck.length - room.round.drawIdx} left in the deck`}
              </div>
            </div>
          </div>
        </>
      )}

      {room.phase === "results" && (
        <>
          <Track round={room.round} racing={false} rules={room.rules} />
          <div style={{ margin: "16px 0" }}>
            {players.map((p) => {
              const bet = p.roundId === room.round.roundId ? p : null;
              const o = outcome(bet, room.round.winner);
              const inc = incomingFor(p.id, players, room.round.roundId);
              const incTotal = inc.reduce((a, q) => a + q.n, 0);
              return (
                <div key={p.id} className="hr-chip" style={{ background: o.give ? "rgba(240,194,75,.15)" : C.turf, border: `1px solid ${o.give ? C.tote : C.rail}`, borderRadius: 10, padding: "10px 14px", marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <b>{p.name}</b>
                    <span style={{ color: o.give ? C.tote : o.drink ? C.red : C.chalkDim }}>{o.label}</span>
                  </div>
                  {incTotal > 0 && (
                    <div style={{ fontSize: 13, color: C.red, marginTop: 4 }}>
                      🍺 +{incTotal} sent by {inc.map((q) => `${q.from} (${q.n})`).join(", ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ color: C.chalkDim, fontSize: 13, textAlign: "center", marginBottom: 12 }}>
            Winners are picking who drinks on their phones — sent sips show up here live.
          </div>
          <button className="hr-btn" style={{ background: C.tote, color: C.ink }}
            onClick={() => writeRoom({ ...room, phase: "betting", round: freshRound(room.round.roundId + 1) })}>
            Race again
          </button>
        </>
      )}

      <button className="hr-btn" style={{ background: "transparent", color: C.chalkDim, fontSize: 14, marginTop: 10 }} onClick={onExit}>
        Leave
      </button>
    </div>
  );
}

/* ================================================================ */
/*  BIG SCREEN (TV / laptop spectator display)                      */
/* ================================================================ */

function BigScreenView({ code, onExit }) {
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [gone, setGone] = useState(false);

  useRaceSfx(room);

  // poll room
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await sGet(roomKey(code));
      if (!live) return;
      if (!r) { setGone(true); return; }
      setRoom(r);
    };
    load();
    const unsub = subscribeKey(roomKey(code), (v) => { if (live && v) setRoom(v); });
    const t = setInterval(load, 8000); // realtime does the work; poll is a safety net
    return () => { live = false; unsub(); clearInterval(t); };
  }, [code]);

  // poll players
  useEffect(() => {
    let live = true;
    const load = async () => {
      const ps = await loadRoster(code);
      if (live) setPlayers(ps);
    };
    load();
    const unsub = subscribePrefix(`hr:${code}:p:`, load);
    const t = setInterval(load, 8000);
    return () => { live = false; unsub(); clearInterval(t); };
  }, [code]);

  if (gone) return (
    <div className="hr-wrap" style={{ textAlign: "center", paddingTop: 60 }}>
      <ToteHeader sub="Hmm" />
      <p>No race found for code <b>{code}</b>.</p>
      <button className="hr-btn" style={{ background: C.tote, color: C.ink }} onClick={onExit}>Back</button>
    </div>
  );
  if (!room) return <div className="hr-bigwrap" style={{ textAlign: "center", paddingTop: 80 }}>Finding the track…</div>;

  const phaseLabel =
    room.phase === "lobby" ? "Riders joining" :
    room.phase === "betting" ? "Bets open" :
    room.phase === "race" ? "🏇 They're racing!" : "Results";

  return (
    <div className="hr-bigwrap">
      {/* header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <div className="hr-display" style={{ fontSize: 56, color: C.tote, lineHeight: 1 }}>Horse Race</div>
          <div style={{ color: C.chalkDim, fontSize: 15, letterSpacing: ".14em", textTransform: "uppercase" }}>{phaseLabel}</div>
        </div>
        <div style={{ background: C.tote, color: C.ink, borderRadius: 16, padding: "10px 22px", textAlign: "center" }}>
          <div style={{ fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: ".12em" }}>Join with code</div>
          <div className="hr-display" style={{ fontSize: 46, letterSpacing: ".2em", lineHeight: 1.05 }}>{room.code}</div>
        </div>
      </div>

      {room.phase === "lobby" ? (
        <div style={{ textAlign: "center", padding: "30px 0" }}>
          <div style={{ width: 180, height: 130, margin: "0 auto" }}><Horse s="H" galloping /></div>
          <div className="hr-display" style={{ fontSize: 34, color: C.chalk, marginBottom: 20 }}>
            Grab your phone and join with code <span style={{ color: C.tote }}>{room.code}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
            {players.map((p) => (
              <div key={p.id} className="hr-chip" style={{ background: C.turf, border: `1px solid ${C.rail}`, borderRadius: 999, padding: "10px 20px", fontSize: 20, fontWeight: 700 }}>
                {p.name}
              </div>
            ))}
            {players.length === 0 && <span style={{ color: C.chalkDim, fontStyle: "italic", fontSize: 18 }}>Waiting for the first rider…</span>}
          </div>
        </div>
      ) : (
        <div className="hr-biggrid">
          <div>
            <Track round={room.round} racing={room.phase === "race"} rules={room.rules} big />
          </div>
          <aside>
            {room.phase === "race" && (
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
                <DrawnCard round={room.round} big />
              </div>
            )}
            {room.phase === "results" && (
              <div className="hr-display hr-chip" style={{ background: C.tote, color: C.ink, borderRadius: 14, padding: "14px 16px", fontSize: 30, textAlign: "center", marginBottom: 12 }}>
                {SUITS[room.round.winner].sym} {SUITS[room.round.winner].name} wins!
              </div>
            )}
            <div style={{ fontSize: 13, color: C.chalkDim, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 8 }}>
              {room.phase === "results" ? "The damage" : "The betting board"}
            </div>
            {/* during the race: one row per suit, showing who's riding it and for how many sips */}
            {room.phase === "race" && SUIT_KEYS.map((s) => {
              const backers = players.filter((p) => p.roundId === room.round.roundId && p.suit === s);
              return (
                <div key={s} className="hr-chip" style={{
                  display: "flex", alignItems: "center", gap: 10,
                  background: C.turf, border: `1px solid ${C.rail}`, borderRadius: 10,
                  padding: "10px 12px", marginBottom: 6, fontSize: 16,
                }}>
                  <span style={{ fontSize: 26, lineHeight: 1, width: 28, textAlign: "center", color: SUITS[s].red ? C.red : C.chalk }}>
                    {SUITS[s].sym}
                  </span>
                  <div style={{ flex: 1, lineHeight: 1.35 }}>
                    {backers.length
                      ? backers.map((p) => `${p.name} (${p.drinks})`).join(", ")
                      : <span style={{ color: C.chalkDim, fontStyle: "italic" }}>no backers</span>}
                  </div>
                </div>
              );
            })}
            {room.phase !== "race" && [...players]
              .sort((a, b) => {
                if (room.phase !== "results") return 0;
                const ao = outcome(a.roundId === room.round.roundId ? a : null, room.round.winner);
                const bo = outcome(b.roundId === room.round.roundId ? b : null, room.round.winner);
                return bo.give - ao.give || bo.drink - ao.drink;
              })
              .map((p) => {
                const bet = p.roundId === room.round.roundId && p.suit ? p : null;
                if (room.phase === "results") {
                  const o = outcome(bet, room.round.winner);
                  const inc = incomingFor(p.id, players, room.round.roundId);
                  const incTotal = inc.reduce((a, q) => a + q.n, 0);
                  return (
                    <div key={p.id} className="hr-chip" style={{ background: o.give ? "rgba(240,194,75,.15)" : C.turf, border: `1px solid ${o.give ? C.tote : C.rail}`, borderRadius: 10, padding: "12px 14px", marginBottom: 6, fontSize: 17 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <b>{p.name}</b>
                        <span style={{ color: o.give ? C.tote : o.drink ? C.red : C.chalkDim, textAlign: "right" }}>{o.label}</span>
                      </div>
                      {incTotal > 0 && (
                        <div style={{ fontSize: 14, color: C.red, marginTop: 4 }}>
                          🍺 +{incTotal} sent by {inc.map((q) => `${q.from} (${q.n})`).join(", ")}
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={p.id} className="hr-chip" style={{ display: "flex", justifyContent: "space-between", background: C.turf, border: `1px solid ${C.rail}`, borderRadius: 10, padding: "12px 14px", marginBottom: 6, fontSize: 17 }}>
                    <b>{p.name}</b>
                    <span style={{ color: bet ? C.tote : C.chalkDim }}>
                      {bet ? <>{SUITS[bet.suit].sym} · {bet.drinks} sips</> : "deciding…"}
                    </span>
                  </div>
                );
              })}
            {players.length === 0 && <div style={{ color: C.chalkDim, fontStyle: "italic" }}>No riders yet.</div>}
            {room.rules?.flipDrink && (
              <div style={{ color: C.chalkDim, fontSize: 13, marginTop: 12 }}>
                🍻 House rule on: everyone drinks when a track card flips.
              </div>
            )}
          </aside>
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: 24 }}>
        <button className="hr-btn" style={{ background: "transparent", color: C.chalkDim, fontSize: 14, maxWidth: 200, margin: "0 auto" }} onClick={onExit}>
          Leave
        </button>
        <p style={{ color: C.chalkDim, fontSize: 13 }}>Hold your horses — Please drink responsibly.</p>
      </div>
    </div>
  );
}

/* ================================================================ */
/*  PLAYER                                                          */
/* ================================================================ */

function PlayerView({ code, name, onExit }) {
  const [room, setRoom] = useState(null);
  const [gone, setGone] = useState(false);
  const [suit, setSuit] = useState(null);
  const [drinks, setDrinks] = useState(2);
  const [placedRound, setPlacedRound] = useState(0);
  const [roster, setRoster] = useState([]);
  const [alloc, setAlloc] = useState({});
  const [gaveRound, setGaveRound] = useState(0);
  const id = slug(name);

  const betPlaced = room ? placedRound === room.round.roundId : false;
  const myWin = room?.phase === "results" ? (betPlaced ? suit === room.round.winner : null) : "spect";
  useRaceSfx(room, myWin);

  const joinedAtRef = useRef(Date.now());

  // register once on join — never clobber an existing bet (e.g. after a page refresh,
  // rejoin with the same name and your bet is restored)
  useEffect(() => {
    let live = true;
    (async () => {
      const existing = await sGet(playerKey(code, id));
      if (!live) return;
      if (existing) {
        await sSet(playerKey(code, id), { ...existing, name });
        if (existing.suit) {
          setSuit(existing.suit);
          setDrinks(existing.drinks || 2);
          setPlacedRound(existing.roundId || 0);
        }
      } else {
        await sSet(playerKey(code, id), { name, joinedAt: joinedAtRef.current, suit: null, drinks: 0, roundId: 0 });
      }
    })();
    return () => { live = false; };
  }, [code, id, name]);

  // poll the room (faster during the race) — read-only, safe to restart on phase change
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await sGet(roomKey(code));
      if (!live) return;
      if (!r) { setGone(true); return; }
      setRoom(r);
    };
    load();
    const unsub = subscribeKey(roomKey(code), (v) => { if (live && v) setRoom(v); });
    const t = setInterval(load, 8000); // realtime does the work; poll is a safety net
    return () => { live = false; unsub(); clearInterval(t); };
  }, [code]);

  // during results, poll the full roster (to pick targets + see sips sent to you)
  useEffect(() => {
    if (room?.phase !== "results") return;
    let live = true;
    const load = async () => {
      const ps = await loadRoster(code);
      if (live) setRoster(ps);
    };
    load();
    const unsub = subscribePrefix(`hr:${code}:p:`, load);
    const t = setInterval(load, 8000);
    return () => { live = false; unsub(); clearInterval(t); };
  }, [room?.phase, code]);

  // reset allocation when a new round starts
  useEffect(() => { setAlloc({}); }, [room?.round?.roundId]);

  const placeBet = async () => {
    await sSet(playerKey(code, id), { name, joinedAt: joinedAtRef.current, suit, drinks, roundId: room.round.roundId });
    setPlacedRound(room.round.roundId);
  };

  const lockGives = async () => {
    await sSet(playerKey(code, id), {
      name, joinedAt: joinedAtRef.current, suit, drinks,
      roundId: room.round.roundId,
      gives: alloc, givesRound: room.round.roundId,
    });
    setGaveRound(room.round.roundId);
    sfx.sent();
  };

  if (gone) return (
    <div className="hr-wrap" style={{ textAlign: "center", paddingTop: 60 }}>
      <ToteHeader sub="Hmm" />
      <p>No race found for code <b>{code}</b>. Double-check it with your host.</p>
      <button className="hr-btn" style={{ background: C.tote, color: C.ink }} onClick={onExit}>Back</button>
    </div>
  );
  if (!room) return <div className="hr-wrap" style={{ textAlign: "center", paddingTop: 80 }}>Finding the track…</div>;

  return (
    <div className="hr-wrap">
      <ToteHeader sub={`Riding as ${name} · Room ${code}`} />

      {room.phase === "lobby" && (
        <div style={{ textAlign: "center", padding: "40px 0", color: C.chalkDim }}>
          <div style={{ width: 130, height: 96, margin: "0 auto" }}><Horse s="D" galloping /></div>
          <p style={{ animation: "pulse 1.6s infinite" }}>You're in. Waiting for the host to open betting…</p>
          {room.rules?.flipDrink && <p style={{ fontSize: 13 }}>🍻 House rule on: everyone drinks when a track card flips.</p>}
        </div>
      )}

      {room.phase === "betting" && !betPlaced && (
        <>
          <div style={{ fontSize: 13, color: C.chalkDim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Pick your horse</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
            {SUIT_KEYS.map((s) => (
              <button key={s} className="hr-btn" onClick={() => setSuit(s)} style={{
                background: suit === s ? C.card : C.turf,
                color: suit === s ? (SUITS[s].red ? C.red : C.ink) : C.chalk,
                border: `2px solid ${suit === s ? C.tote : C.rail}`,
                padding: "10px 0 6px",
              }}>
                <span style={{ display: "block", width: 74, height: 54, margin: "0 auto" }}>
                  <Horse s={s} galloping={suit === s} />
                </span>
                <span style={{ fontSize: 15 }}>
                  <span style={{ fontSize: 18, color: suit === s ? (SUITS[s].red ? C.red : C.ink) : (SUITS[s].red ? C.red : C.chalk) }}>{SUITS[s].sym}</span> {SUITS[s].name}
                </span>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 13, color: C.chalkDim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Wager (sips)</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, marginBottom: 18 }}>
            <button className="hr-btn" style={{ width: 56, background: C.turf, color: C.chalk, border: `2px solid ${C.rail}` }} onClick={() => setDrinks(Math.max(1, drinks - 1))}>−</button>
            <span className="hr-display" style={{ fontSize: 48, color: C.tote, minWidth: 60, textAlign: "center" }}>{drinks}</span>
            <button className="hr-btn" style={{ width: 56, background: C.turf, color: C.chalk, border: `2px solid ${C.rail}` }} onClick={() => setDrinks(Math.min(10, drinks + 1))}>+</button>
          </div>
          <div style={{ fontSize: 13, color: C.chalkDim, textAlign: "center", marginBottom: 14 }}>
            Win: give out {drinks * 2} sips · Lose: drink {drinks}
          </div>
          <button className="hr-btn" style={{ background: C.tote, color: C.ink }} disabled={!suit} onClick={placeBet}>
            Lock it in
          </button>
        </>
      )}

      {room.phase === "betting" && betPlaced && (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ width: 150, height: 110, margin: "0 auto" }}><Horse s={suit} galloping /></div>
          <p><b>{drinks} sips on {SUITS[suit].name}.</b></p>
          <p style={{ color: C.chalkDim, animation: "pulse 1.6s infinite" }}>Waiting for the gates to open…</p>
          <button className="hr-btn" style={{ background: "transparent", color: C.chalkDim, fontSize: 14 }} onClick={() => setPlacedRound(0)}>Change bet</button>
        </div>
      )}

      {room.phase === "race" && (
        <>
          <Track round={room.round} racing rules={room.rules} />
          <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "center", marginTop: 14 }}>
            <DrawnCard round={room.round} />
            {betPlaced && (
              <div style={{ color: C.chalkDim, fontSize: 14, maxWidth: 190 }}>
                You're on {SUITS[suit].sym} {SUITS[suit].name} for {drinks} sips — go go go!
              </div>
            )}
          </div>
        </>
      )}

      {room.phase === "results" && (() => {
        const bet = betPlaced ? { suit, drinks } : null;
        const o = outcome(bet, room.round.winner);
        const won = o.give > 0;
        const others = roster.filter((p) => p.id !== id);
        const incoming = incomingFor(id, roster, room.round.roundId);
        const incTotal = incoming.reduce((a, q) => a + q.n, 0);
        const assigned = Object.values(alloc).reduce((a, b) => a + (b || 0), 0);
        const left = o.give - assigned;
        const gavesLocked = gaveRound === room.round.roundId;
        return (
          <div>
            <Track round={room.round} racing={false} rules={room.rules} />

            {/* your result card */}
            <div className="hr-chip" style={{ marginTop: 16, textAlign: "center", background: won ? "rgba(240,194,75,.15)" : C.turf, border: `2px solid ${won ? C.tote : C.rail}`, borderRadius: 16, padding: 22 }}>
              <div style={{ fontSize: 44 }}>{won ? "🏆" : bet ? "🍺" : "😶"}</div>
              <div className="hr-display" style={{ fontSize: 26, color: won ? C.tote : C.chalk }}>{o.label}</div>
            </div>

            {/* sips sent to you by winners */}
            {incoming.map((q, i) => (
              <div key={i} className="hr-chip" style={{ marginTop: 8, background: "rgba(224,82,82,.12)", border: `1px solid ${C.red}`, borderRadius: 12, padding: "12px 14px", textAlign: "center" }}>
                🍺 <b>{q.from}</b> sent you <b style={{ color: C.red }}>{q.n} sips</b>
              </div>
            ))}
            {incTotal > 0 && (
              <div style={{ textAlign: "center", marginTop: 8, fontSize: 15 }}>
                Total damage: <b style={{ color: C.red }}>{o.drink + incTotal} sips</b>
              </div>
            )}

            {/* winner: hand out your sips */}
            {won && !gavesLocked && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 13, color: C.chalkDim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
                  Hand out your sips · <b style={{ color: left === 0 ? C.tote : C.chalk }}>{left} left</b>
                </div>
                {others.map((p) => {
                  const n = alloc[p.id] || 0;
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: n > 0 ? "rgba(240,194,75,.12)" : C.turf, border: `1px solid ${n > 0 ? C.tote : C.rail}`, borderRadius: 10, padding: "8px 12px", marginBottom: 6 }}>
                      <b style={{ flex: 1 }}>{p.name}</b>
                      <button className="hr-btn" style={{ width: 44, padding: "8px 0", background: C.turfDeep, color: C.chalk, border: `1px solid ${C.rail}` }}
                        disabled={n === 0} onClick={() => setAlloc({ ...alloc, [p.id]: n - 1 })}>−</button>
                      <span className="hr-display" style={{ fontSize: 24, minWidth: 30, textAlign: "center", color: n > 0 ? C.tote : C.chalkDim }}>{n}</span>
                      <button className="hr-btn" style={{ width: 44, padding: "8px 0", background: C.turfDeep, color: C.chalk, border: `1px solid ${C.rail}` }}
                        disabled={left === 0} onClick={() => setAlloc({ ...alloc, [p.id]: n + 1 })}>+</button>
                    </div>
                  );
                })}
                {others.length === 0 && <div style={{ color: C.chalkDim, fontStyle: "italic" }}>No other riders to punish — lucky them.</div>}
                <button className="hr-btn" style={{ background: C.tote, color: C.ink, marginTop: 8 }}
                  disabled={others.length === 0 || left !== 0} onClick={lockGives}>
                  Send the sips 🍻
                </button>
              </div>
            )}
            {won && gavesLocked && (
              <div className="hr-chip" style={{ marginTop: 14, textAlign: "center", background: C.turf, border: `1px solid ${C.rail}`, borderRadius: 12, padding: 14 }}>
                Sent: {others.filter((p) => alloc[p.id] > 0).map((p) => `${p.name} (${alloc[p.id]})`).join(", ") || "—"}
                <button className="hr-btn" style={{ background: "transparent", color: C.chalkDim, fontSize: 13, marginTop: 6 }} onClick={() => setGaveRound(0)}>
                  Change
                </button>
              </div>
            )}

            <p style={{ color: C.chalkDim, fontSize: 14, textAlign: "center", animation: "pulse 1.6s infinite", marginTop: 14 }}>
              Waiting for the host to start the next race…
            </p>
          </div>
        );
      })()}

      <button className="hr-btn" style={{ background: "transparent", color: C.chalkDim, fontSize: 14, marginTop: 10 }} onClick={onExit}>
        Leave
      </button>
    </div>
  );
}

/* ================================================================ */
/*  HOME                                                            */
/* ================================================================ */

export default function App() {
  const [screen, setScreen] = useState("home"); // home | host | player | resume | bigscreen
  const [joinCode, setJoinCode] = useState("");
  const [name, setName] = useState("");
  const [resumeCode, setResumeCode] = useState("");
  const exit = () => { setScreen("home"); setJoinCode(""); setResumeCode(""); };

  // unlock audio on the first tap anywhere (browser autoplay policy)
  useEffect(() => {
    const h = () => sfx.unlock();
    window.addEventListener("pointerdown", h, { once: true });
    return () => window.removeEventListener("pointerdown", h);
  }, []);

  return (
    <div className="hr-root">
      <Styles />
      <SoundToggle />
      {screen === "home" && (
        <div className="hr-wrap" style={{ paddingTop: 48 }}>
          <div style={{ width: 170, height: 120, margin: "0 auto 4px" }}><Horse s="H" galloping /></div>
          <ToteHeader sub="The card game · bet in sips" />
          <button className="hr-btn" style={{ background: C.tote, color: C.ink, marginBottom: 20 }} onClick={() => setScreen("host")}>
            Host a race
          </button>
          <div style={{ borderTop: `1px dashed ${C.rail}`, margin: "6px 0 20px" }} />
          <input className="hr-input" placeholder="Your name" value={name} maxLength={16}
            onChange={(e) => setName(e.target.value)} style={{ marginBottom: 8 }} />
          <input className="hr-input" placeholder="Room code" value={joinCode} maxLength={4}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
            style={{ marginBottom: 12, textTransform: "uppercase", letterSpacing: ".2em", textAlign: "center" }} />
          <button className="hr-btn" style={{ background: C.red, color: C.chalk, marginBottom: 8 }}
            disabled={joinCode.length !== 4 || !name.trim()} onClick={() => setScreen("player")}>
            Join the race
          </button>
          <button className="hr-btn" style={{ background: C.turf, color: C.chalk, border: `2px solid ${C.rail}`, fontSize: 15 }}
            disabled={joinCode.length !== 4} onClick={() => setScreen("bigscreen")}>
            📺 Watch on a big screen
          </button>
          <div style={{ textAlign: "center", marginTop: 26 }}>
            <input className="hr-input" placeholder="Resume hosting (code)" value={resumeCode} maxLength={4}
              onChange={(e) => setResumeCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
              style={{ maxWidth: 220, display: "inline-block", textAlign: "center", fontSize: 14, padding: 10 }} />
            <button className="hr-btn" style={{ background: "transparent", color: C.chalkDim, fontSize: 14 }}
              disabled={resumeCode.length !== 4} onClick={() => setScreen("resume")}>
              Resume as host →
            </button>
          </div>
          <p style={{ color: C.chalkDim, fontSize: 12, textAlign: "center", marginTop: 30, lineHeight: 1.5 }}>
            Hold your horses — Please drink responsibly.
          </p>
        </div>
      )}
      {screen === "host" && <HostView onExit={exit} />}
      {screen === "resume" && <HostView resumeCode={resumeCode} onExit={exit} />}
      {screen === "player" && <PlayerView code={joinCode} name={name.trim()} onExit={exit} />}
      {screen === "bigscreen" && <BigScreenView code={joinCode} onExit={exit} />}
    </div>
  );
}
