See CONTRIBUTING.md for the checks to run and the three test layers. A fix or a change that crosses a boundary comes with an integration or end-to-end test that fails without it.

A user-visible change is proven in the real app per the `verify-wt-dash` skill (`.claude/skills/verify-wt-dash/`), and a change to a feature's behavior updates its feature file there; lint and tests do not substitute for it.
