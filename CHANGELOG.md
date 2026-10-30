# Changelog

## 0.2.0

- OS modeling: `os` blocks with a profile (`autosar`, `osek`, `threadx`, `freertos`, `generic`), tasks, ISRs, mutexes, semaphores, queues and events.
- Runnable-to-task mapping with `runs Swc.Runnable`, across files; BSW main functions included.
- New checks: profile rules, object usage, priority inversion, lock-order deadlocks, blocking ISRs, completeness and periods of the runnable mapping.
- OS view: tasks and ISRs with their runnables, and the objects they share.
- Marketplace metadata and icon.

## 0.1.0

- First version: interfaces, SWCs, BSW modules, compositions and views.
- Checks for ports, connectors, runnable accesses, BSW layering and names across files.
- Composition, component and layers views; VS Code preview and SVG export; `ardl check` and `ardl render` on the command line.
