import { useState } from "react";
const steps = [
  ["Organize", "Your work, visible", "Every Codex thread becomes a card. Categories are your prefixes and projects stay filterable.", "board"],
  ["Work", "Stay inside the conversation", "Chat, queue instructions, answer questions and approve commands without switching apps.", "chat"],
  ["Remote", "The same board on mobile", "Pair once through Tailscale. Desktop remains the engine; mobile becomes the secure remote.", "remote"],
  ["Automate", "Let routines run themselves", "Schedule recurring prompts and timed moves that persist across restarts.", "automation"],
];
function Art({ kind }: { kind: string }) { return <div className={`tour-art ${kind}`}><i /><i /><i /><b>→</b><span /></div>; }
export function ProductTour({ onClose }: { onClose: () => void }) { const [index,setIndex]=useState(0); const step=steps[index]; return <div className="dialog-backdrop tour-backdrop"><section className="product-tour"><div className="tour-visual"><div className="brand-mark"><span /><span /><span /></div><Art kind={step[3]} /></div><div className="tour-copy"><button className="tour-skip" onClick={onClose}>Skip</button><span className="eyebrow">{step[0]}</span><h2>{step[1]}</h2><p>{step[2]}</p><div className="tour-dots">{steps.map((_,dot)=><i key={dot} className={dot===index?"active":""}/>)}</div><footer><button disabled={index===0} onClick={()=>setIndex(index-1)}>Back</button><button className="tour-next" onClick={()=>index===steps.length-1?onClose():setIndex(index+1)}>{index===steps.length-1?"Start using Board":"Next"}</button></footer></div></section></div>; }
