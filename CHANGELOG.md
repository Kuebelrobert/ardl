# Changelog

## Unreleased

- An OS can be split into several `os` blocks of the same name, in one file or across files (e.g. application tasks, BSW scheduling and supervision apart). Checks and `view ... os` work on the merged OS; the default view of a file without views shows the parts of that file.
- `resource`: lock with the immediate priority ceiling protocol, in every profile (AUTOSAR/OSEK resource, or its emulation on an RTOS). Category 2 ISRs may lock resources.
- Exclusive areas for SWCs and BSW modules: `exclusive Ea` in the component, `enters Ea` in the runnable. Shown in the component view; unused areas and areas entered from one task only are reported.
- Changed: `mutex` has the protocols `inherit` (default) and `none`. `protocol ceiling` is now a `resource`; AUTOSAR/OSEK have resources and no mutexes.

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
