// Three benches. Components: each piece of the kit in every variant, on the same quests. Alignment: the same rows
// under five alignment systems, with the left edges counted. Motion: each move the interface makes, one at a time.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ATTENTION, LOOP_STAGES, byAttention, journeyOf, loopPoint, stage, type QuestView, type StageId } from "../loop/model.ts";
import {
  AttemptLadder, AttentionMark, DiveProfile, FleetSentence, FleetTally, JourneyList, LoopMeter, QuestionCard, QuestRow, Specimen,
  loopAsset, type LadderVariant, type MeterVariant, type RowVariant,
} from "../loop/parts.tsx";
import type { QuestWorld, World } from "../loop/scenario.ts";

const vars = (values: Record<string, string | number>) => values as CSSProperties;
const byShort = (world: World, hex: string): QuestWorld | undefined => world.quests.find((quest) => quest.view.short === `T-${hex}`);

function Variant({ of, id, name, children, pick }: { of: string; id: string; name: string; children: ReactNode; pick?: boolean }) {
  return (
    <figure className="lab-variant" data-variant-of={of} data-variant={id} data-pick={pick || undefined}>
      <figcaption>{name}{pick && <span>chosen</span>}</figcaption>
      <div>{children}</div>
    </figure>
  );
}

function Bench({ id, title, verdict, children }: { id: string; title: string; verdict: string; children: ReactNode }) {
  return (
    <section className="lab-bench" data-bench={id}>
      <h2>{title}</h2>
      <p className="lab-verdict">{verdict}</p>
      <div className="lab-variants">{children}</div>
    </section>
  );
}

const ROWS: [RowVariant, string][] = [["strip", "Strip: one line, shared columns"], ["sentence", "Sentence: two lines"], ["card", "Card"]];
const METERS: [MeterVariant, string][] = [["path", "Path: the loop's own shape"], ["strip", "Strip: eight segments"], ["ring", "Ring"]];
const LADDERS: [LadderVariant, string][] = [["rungs", "Rungs: each try and what it ran into"], ["pills", "Pills"], ["strike", "Struck list"]];
const SPRITES = ["signal", "evidence", "hypothesis", "repro", "patch", "proof", "landing", "watch", "stuck", "rollback"];

export function ComponentBench({ world }: { world: World }) {
  const views = [...world.views].sort(byAttention);
  const recovering = world.quests.find((quest) => quest.view.ladder.length > 1 && quest.view.attention === "recovering")
    ?? byShort(world, "7f3a2c");
  const held = world.quests.find((quest) => quest.view.attention === "held");
  const asking = world.quests.find((quest) => quest.view.question);
  const reverted = world.quests.find((quest) => quest.view.retreats > 0 && quest.view.attention !== "recovering") ?? recovering;
  return (
    <div className="lab-benches" data-lab="components">
      <Bench id="fleet" title="The answer" verdict="Sentence. The tally is faster to scan but drops the reasons (recovering, asking, rolling back).">
        <Variant of="fleet" id="sentence" name="Sentence" pick><FleetSentence fleet={world.fleet} as="p" /></Variant>
        <Variant of="fleet" id="tally" name="Tally"><FleetTally fleet={world.fleet} /></Variant>
      </Bench>

      <Bench id="row" title="Quest row"
        verdict="Strip on wide screens, sentence below 720 px. Cards only where position already means something (the tide map).">
        {ROWS.map(([id, name]) => (
          <Variant key={id} of="row" id={id} name={name} pick={id === "strip"}>
            <ul className="lp-rows" data-variant={id}>
              {views.map((view, i) => <QuestRow key={view.id} quest={view} variant={id} index={i} />)}
            </ul>
          </Variant>
        ))}
      </Bench>

      <Bench id="meter" title="Loop meter"
        verdict="Path. It is the only one where a retreat looks like one: the dot goes back down. Strip is the fallback under 96 px.">
        {METERS.map(([id, name]) => (
          <Variant key={id} of="meter" id={id} name={name} pick={id === "path"}>
            <ul className="lab-meter-list">
              {views.map((view) => (
                <li key={view.id} data-attention={view.attention}>
                  <LoopMeter quest={view} variant={id} /><span>{view.stage.label}</span><AttentionMark attention={view.attention} />
                </li>
              ))}
            </ul>
          </Variant>
        ))}
      </Bench>

      <Bench id="ladder" title="Attempts" verdict="Rungs in the detail view. Pills lose what each attempt ran into, which is the point.">
        {LADDERS.map(([id, name]) => (
          <Variant key={id} of="ladder" id={id} name={name} pick={id === "rungs"}>
            {recovering && <AttemptLadder ladder={recovering.view.ladder} variant={id} />}
            {held && held.view.ladder.length > 0 && <AttemptLadder ladder={held.view.ladder} variant={id} />}
          </Variant>
        ))}
      </Bench>

      {asking?.view.question && (
        <Bench id="question" title="A question to a person" verdict="Letter in the detail view; compact in lists. Both keep who, why them and the check.">
          <Variant of="question" id="letter" name="Letter" pick><QuestionCard question={asking.view.question} /></Variant>
          <Variant of="question" id="compact" name="Compact"><QuestionCard question={asking.view.question} variant="compact" /></Variant>
        </Bench>
      )}

      {reverted && (
        <Bench id="journey" title="Path through the loop" verdict="Both: the dive profile to see the shape, the last four sentences to read why.">
          <Variant of="journey" id="dive" name="Dive profile" pick>
            <DiveProfile steps={journeyOf(reverted.events, reverted.trail)} />
            {recovering && recovering !== reverted && <DiveProfile steps={journeyOf(recovering.events, recovering.trail)} />}
          </Variant>
          <Variant of="journey" id="list" name="Sentences"><JourneyList steps={journeyOf(reverted.events, reverted.trail)} /></Variant>
        </Bench>
      )}

      <Bench id="marks" title="Status marks" verdict="A glyph and a word each. Colour only repeats what the glyph already says.">
        <Variant of="marks" id="all" name="All eight" pick>
          <ul className="lab-mark-list">
            {ATTENTION.map((attention) => <li key={attention} data-attention={attention}><AttentionMark attention={attention} /></li>)}
          </ul>
        </Variant>
      </Bench>

      <Bench id="specimens" title="Specimens" verdict="One life stage per loop stage, plus a cyst for stopped and a slump for rolled back.">
        <Variant of="specimens" id="all" name="Ten sprites" pick>
          <ul className="lab-sprite-list">
            {SPRITES.map((name) => (
              <li key={name}><img src={loopAsset(name)} alt="" width={64} height={64} /><span>{name}</span></li>
            ))}
          </ul>
        </Variant>
      </Bench>
    </div>
  );
}

// ───────────────────────── Alignment ─────────────────────────

const SYSTEMS = [
  { id: "tracks", name: "Shared tracks", note: "Rows borrow their list's columns (subgrid). Five things, five edges." },
  { id: "hanging", name: "Hanging mark", note: "Status hangs in the margin. Title and reason share one edge." },
  { id: "edge", name: "One edge", note: "Everything starts at the same x. Calm, but tall." },
  { id: "ragged", name: "Ragged", note: "Each row sizes its own columns, which is what a flex row does by default." },
  { id: "centred", name: "Centred", note: "Centred cards. No edge survives from one card to the next." },
] as const;

function AlignRow({ view }: { view: QuestView }) {
  return (
    <li data-attention={view.attention}>
      <span data-rail className="lab-al-mark"><AttentionMark attention={view.attention} /></span>
      <span data-rail className="lab-al-id">{view.short}</span>
      <span data-rail className="lab-al-title">{view.title}</span>
      <span data-rail className="lab-al-meter"><LoopMeter quest={view} variant="strip" /></span>
      <span data-rail className="lab-al-headline">{view.headline}</span>
    </li>
  );
}

function AlignSystem({ id, name, note, views, pick }: { id: string; name: string; note: string; views: QuestView[]; pick: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const [rails, setRails] = useState<number[]>([]);
  useLayoutEffect(() => {
    const measure = () => {
      const host = list.current;
      if (!host) return;
      const origin = host.getBoundingClientRect().left;
      const edges = [...host.querySelectorAll<HTMLElement>("[data-rail]")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => Math.round(el.getBoundingClientRect().left - origin));
      setRails([...new Set(edges)].sort((a, b) => a - b));
    };
    measure();
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => window.removeEventListener("resize", measure);
  }, [views.length]);
  return (
    <figure className="lab-variant lab-al" data-variant-of="alignment" data-variant={id} data-rails={rails.length} data-pick={pick || undefined}>
      <figcaption>{name}{pick && <span>chosen</span>}<b data-rail-count>{rails.length} left edges</b></figcaption>
      <p className="lab-verdict">{note}</p>
      <div className="lab-al-stage">
        <ul ref={list} data-system={id}>{views.map((view) => <AlignRow key={view.id} view={view} />)}</ul>
        <div className="lab-al-rails" aria-hidden="true">
          {rails.map((x) => <i key={x} style={vars({ "--x": `${x}px` })} />)}
        </div>
      </div>
    </figure>
  );
}

export function AlignmentLab({ world }: { world: World }) {
  const views = [...world.views].sort(byAttention);
  return (
    <div className="lab-benches" data-lab="alignment">
      <section className="lab-bench">
        <h2>Alignment</h2>
        <p className="lab-verdict">
          The same seven quests under five alignment systems. An edge is a distinct x where something starts; the red lines draw them.
          Fewer edges means the eye travels down a column instead of hunting across a row.
        </p>
        <div className="lab-variants" data-columns="1">
          {SYSTEMS.map((system) => <AlignSystem key={system.id} {...system} views={views} pick={system.id === "tracks"} />)}
        </div>
      </section>
    </div>
  );
}

// ───────────────────────── Motion ─────────────────────────

const at = (id: StageId) => loopPoint((stage(id).index + 0.5) / LOOP_STAGES.length);

/** A small water column with one specimen, moved from `from` to `to` a moment after it mounts. */
function Glide({ from, to, tone }: { from: StageId; to: StageId; tone: QuestView["attention"] }) {
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMoved(true), 350);
    return () => clearTimeout(timer);
  }, []);
  const where = moved ? to : from;
  const point = at(where);
  return (
    <div className="lab-scene lab-mini-scene">
      <div className="lab-scene-field" style={vars({ "--pitch": "0px" })}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={Array.from({ length: 33 }, (_, i) => {
            const p = loopPoint(i / 32);
            return `${(p.x * 100).toFixed(1)},${(p.depth * 100).toFixed(1)}`;
          }).join(" ")} />
        </svg>
        <ul>
          <li data-attention={moved ? tone : "self"} style={vars({ "--x": point.x.toFixed(4), "--y": point.depth.toFixed(4), "--slot": 0 })}>
            <Specimen quest={{ attention: moved ? tone : "self", stage: stage(where) }} size={48} />
          </li>
        </ul>
      </div>
    </div>
  );
}

function Swap() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => setN(2), 500);
    return () => clearTimeout(timer);
  }, []);
  const rung = (i: number, strategy: "initial" | "alternate_hypothesis", label: string) => ({
    key: `demo-${i}`, step: "patch", rev: i, n: i, max: 3, strategy, label, means: "A new idea about the cause.", exhausted: false,
    reason: null, observations: i > 1 ? ["Missing proof: repro_after"] : [], current: i === n,
  });
  const ladder = [rung(1, "initial", "First approach"), ...(n > 1 ? [rung(2, "alternate_hypothesis", "Different hypothesis")] : [])];
  return <AttemptLadder ladder={ladder} />;
}

const MOTIONS: { id: string; name: string; when: string; spec: string; reduced: string; demo: () => ReactNode }[] = [
  {
    id: "advance", name: "Advance", when: "A quest moves on to the next stage.", spec: "transform, 900 ms, ease-out. The sprite swaps with a 420 ms gel pop.",
    reduced: "Jumps to the new place. The sprite cross-fades.", demo: () => <Glide from="repro" to="patch" tone="self" />,
  },
  {
    id: "retreat", name: "Retreat", when: "A proof fails or production regresses, and the quest sinks back.",
    spec: "The same glide, backwards, and the sprite slumps. Direction is the signal; nothing flashes.",
    reduced: "Jumps back. The mark and the word change.", demo: () => <Glide from="watch" to="evidence" tone="reverted" />,
  },
  {
    id: "bell", name: "Needs you", when: "A blocking checkpoint opens.", spec: "A ring leaves the button three times (1.8 s each), then stops.",
    reduced: "No ring. The loud surface and the word are enough.",
    demo: () => <div className="lp-needs lab-demo-needs"><button type="button" className="lp-primary">Approve landing</button></div>,
  },
  {
    id: "attempt", name: "New attempt", when: "Recovery picks a different strategy.",
    spec: "The new rung arrives with 12 px rise, 4 px blur, 300 ms. The old one is struck through.",
    reduced: "The new rung fades in over 150 ms.", demo: () => <Swap />,
  },
  {
    id: "stagger", name: "Rows arrive", when: "A list is first shown.", spec: "Each row: 12 px rise, 4 px blur, 300 ms, 60 ms apart, at most 8 steps.",
    reduced: "All rows fade in together over 150 ms.",
    demo: () => (
      <ul className="lab-demo-rows">
        {["Signal heard", "Evidence gathered", "Failure reproduced", "Patch proven"].map((text, i) => (
          <li key={text} className="lp-row" style={vars({ "--i": i })}>{text}</li>
        ))}
      </ul>
    ),
  },
  {
    id: "press", name: "Press", when: "Any button is pressed.", spec: "scale(0.96), 150 ms, ease-out. Press and hold to see it.",
    reduced: "Unchanged. It is feedback, not decoration.", demo: () => <button type="button" className="lp-primary">Press me</button>,
  },
  {
    id: "alive", name: "Alive", when: "A quest is moving by itself.", spec: "A 4 px bob every 4.2 s. Stopped and finished quests keep still.",
    reduced: "Still. The mint dot says the same thing.",
    demo: () => (
      <div className="lab-demo-pair">
        <Specimen quest={{ attention: "self", stage: stage("landing") }} size={64} />
        <Specimen quest={{ attention: "held", stage: stage("repro") }} size={64} />
      </div>
    ),
  },
  {
    id: "scrub", name: "Scrub", when: "The replay handle is dragged.", spec: "Glides shorten to 120 ms so specimens stay under the handle.",
    reduced: "Specimens jump with the handle.", demo: () => <p className="lab-demo-note">Drag the bar at the bottom of any layout.</p>,
  },
];

export function MotionBench() {
  const [runs, setRuns] = useState<Record<string, number>>({});
  return (
    <div className="lab-benches" data-lab="motion">
      <section className="lab-bench">
        <h2>Motion</h2>
        <p className="lab-verdict">
          Every move the interface makes, one at a time. Only transform, opacity and filter are animated. Each has a reduced form,
          and the page says the same thing with every animation turned off.
        </p>
        <div className="lab-variants" data-columns="motion">
          {MOTIONS.map((motion) => (
            <figure key={motion.id} className="lab-variant lab-motion" data-motion-demo={motion.id}>
              <figcaption>
                {motion.name}
                <button type="button" className="lp-quiet" onClick={() => setRuns((all) => ({ ...all, [motion.id]: (all[motion.id] ?? 0) + 1 }))}>
                  Replay
                </button>
              </figcaption>
              <div className="lab-motion-stage" key={runs[motion.id] ?? 0}>{motion.demo()}</div>
              <dl>
                <div><dt>When</dt><dd>{motion.when}</dd></div>
                <div><dt>How</dt><dd>{motion.spec}</dd></div>
                <div><dt>Reduced</dt><dd>{motion.reduced}</dd></div>
              </dl>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
