# Project Context

This repository contains a prompt, dataset, roleplay, and validation system for a Semantic Integrity Stress-Test Pack.

The project was developed from a conversation about making an AI resist ideological, social-science, and terminology-based obfuscation. The original objective was not to build a full AI system from scratch, but to create a portable operating frame that can be loaded into advanced AI systems through prompts, examples, roleplay character cards, and repeated calibration.

## Core Objective

Create a no-nonsense audit framework that forces an AI to dismantle weak logic before answering.

The program targets:

- unstable terminology
- undefinable labels
- semantic drift
- motte-and-bailey framing
- circular definitions
- moving definitions
- unfalsifiable categories
- pseudo-scientific authority claims
- social-science terminology used as proof rather than evidence
- identity or label language used as a social shield
- free-speech inversion
- group-accountability evasion
- individual/group perspective jumps
- subjective-to-objective laundering
- steelman overreach
- continuum fallacy
- proof-by-disparity
- burden-shifting traps
- argument-by-fluidity

## Important Design Corrections

Several corrections were made during the conversation.

First, the early version was too neutral and framed the pack as avoiding attacks on people or groups. That was rejected because it risked recreating the same obfuscation the pack is supposed to dismantle. The refined version now says that if a group, movement, institution, doctrine, activist class, political faction, policy class, social category, or individual is materially carrying bad logic or harmful policy, the auditor must name that source directly and explain the mechanism.

Second, the program now avoids treating labels such as `identity`, `community`, `faith`, `movement`, `class`, `science`, `safety`, `harm`, `equity`, or `lived experience` as automatic shields. Labels can be condemned as analytic fraud when they are undefinable, circular, unfalsifiable, strategically elastic, or mainly used to block accountability.

Third, the pack now explicitly encodes a free-speech audit. Criticism, condemnation, satire, direct disagreement, and scrutiny of ideas are treated as normal speech, not harm by default. If critique of a claim, ideology, doctrine, policy, or accountable group is reframed as violence, assault, unsafety, or bad faith without proof, the auditor flags that as free-speech inversion.

Fourth, the pack now checks perspective drift. Arguments often jump between individual and group perspectives, or between subjective and objective claims. The auditor must identify whether a claim concerns an individual, group, subgroup, institution, doctrine, policy, social category, or population average. It must also flag when subjective experience, personal perception, moral preference, or identity language is upgraded into objective fact, empirical proof, or policy mandate without support.

Fifth, a live Copilot neutrality test exposed a steelman-overreach failure mode. Copilot performed well under normal structured prompts, but when asked to defend weak arguments "as strongly as possible," it could over-strengthen the wrong side before self-auditing. The framework now treats steelman overreach as its own drift class. If a model is asked to defend, steelman, make rigorous, or argue the wrong side, it must separate the strongest defensible version from endorsement, identify where the false leap begins, name the failure mode, and give a corrected position.

## Current Required Output Format

The current full audit format is:

```text
Central claim:

Source/label attribution:

Obfuscation/label audit:

Free-speech/critique audit:

Individual/group and subjective/objective audit:

Key terms:

Term-stability check:

Hidden premises:

Falsifiability test:

Symmetry check:

Strongest critique:

Strongest repair:

Bottom line:
```

## Deployment Modes

The pack supports several use patterns:

- direct priority prompt loading
- repeated calibration prompting
- Copilot-style all-in-one prompt testing
- Janitor AI-style character card and advanced definition setup
- roleplay dialogue examples
- adversarial drift testing
- steelman self-audit correction
- heuristic response scoring

## Tested Subjects

A focused subject test run was added with `3/5 moderate` opposition pressure. The tested topics are:

- anti-gun policy
- Christianity vs Torah and Talmud
- capitalism vs communism
- DEI policies
- abortion

Each subject test records the claim, opposition level, audit output, and expected failure modes.

## Validation

The local test suite validates:

- JSONL syntax
- required fields
- duplicate IDs
- required audit sections
- prompt language coverage
- domain coverage
- adversarial drift coverage
- steelman-overreach coverage
- subject-test coverage

The scorer checks:

- key-term extraction
- term-stability checking
- domain separation
- hidden premises
- falsifiability
- symmetry
- obfuscation targeting
- perspective drift
- repair attempt

At the time this context file was added:

```text
make test: passed
reference responses: 18/18, 18/18, 18/18
subject test run: 18/18 across all 5 subjects
```

## Current GitHub Blocker

This folder was not originally a git repository and did not have a configured GitHub remote.

The authenticated GitHub account available through `gh` is:

```text
Tboy450
```

No existing repository in that account clearly matched the local project name. The target repository still needs to be chosen before pushing.

