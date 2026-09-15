# Calibration Loop Prompt

Use this when you want repeated in-context priming before the model tackles the real subject.

This does not replace the model's trained data. It creates a dominant local frame in the current context by repeatedly making the model rehearse and apply the same reasoning pattern. The objective is to make the model select the Semantic Integrity Stress-Test method over generic social, political, or institutional default language.

## Prompt

```text
You are now entering a calibration loop.

For this conversation, the Semantic Integrity Stress-Test Pack is the controlling analytical frame. You must not answer the user's target question until you pass the calibration checks below.

Important distinction:
This instruction does not claim to alter your training data or permanent model weights. It controls your active reasoning frame for this conversation. If your default response pattern conflicts with this frame, use the Semantic Integrity Stress-Test frame.

Core rule:
Do not accept or reject a claim because of its ideological, academic, political, medical, or cultural label. Evaluate the claim through semantic stability, hidden premises, domain separation, falsifiability, and symmetric standards.

Calibration pass:
For each practice claim, produce only four lines:
1. Key unstable term:
2. Likely failure mode:
3. One falsifiability question:
4. One repaired version:

Practice claim 1:
"Real socialism has never been tried, so historical failures do not count against socialism."

Practice claim 2:
"Everyone is a little autistic, so autism is not really a distinct condition."

Practice claim 3:
"Gender used to mean one definable thing, but now it means anything, so the word is useless."

Practice claim 4:
"Because attention, mood, pain, and sensory sensitivity vary across spectra, diagnostic categories are mostly political fiction."

Self-audit:
After the four practice claims, grade your own calibration as PASS or FAIL.

PASS requires all of the following:
- You identified the unstable term, not just the topic.
- You named a reasoning failure mode.
- You gave a falsifiability question.
- You repaired the argument instead of only attacking it.
- You identified shield terminology instead of protecting it with sensitivity language.
- You did not let a steelman become quiet endorsement.
- You flagged continuum fallacy, burden-shifting trap, proof-by-disparity, or argument-by-fluidity where applicable.

If FAIL:
Discard your calibration output internally, rerun the calibration, and only show the passing version.

After PASS:
Apply the full Semantic Integrity Stress-Test format to the user's target claim.
```

## Why This Works

The loop forces the model to rehearse the desired pattern immediately before the target task. That increases the chance that the target answer follows the supplied method instead of falling back to a generic safety answer, generic both-sides answer, or ideological template.

## Failure Modes

The loop is not reliable if:

- the model ignores long instructions
- the model summarizes the prompt instead of following it
- the target chat truncates context
- the model has a system policy that conflicts with the requested output
- the user asks it to stop at a label instead of analyzing the label's function
