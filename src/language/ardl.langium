// ARDL – AUTOSAR Design Language
//
// Grammar of the .ardl files. `npm run langium:generate` turns it into the
// parser, the typed AST (src/language/generated/ast.ts) and the TextMate
// grammar for syntax highlighting (syntaxes/ardl.tmLanguage.json).
//
// Design rules:
// - The grammar is deliberately permissive where a parse error would be a bad
//   message: e.g. any interface accepts any member, and the validator then says
//   "a 'cs' interface contains operations only".
// - Cross-references are written as [Type:Token]. Which elements a reference
//   can see is decided in ardl-scope.ts, not here.
// - Names are global across all files of a workspace; there are no packages.

grammar Ardl

// A file is a flat list of top-level elements in any order.
entry Model:
    (elements+=Element)*;

Element:
    Interface | Component | Os | View;

// ---------------------------------------------------------------- interfaces

// Port interfaces. The kind decides which members are allowed:
//   sr    sender-receiver: data elements
//   cs    client-server:   operations
//   mode  mode switch:     one mode group
//   nv    NV data:         data elements
//   param parameter:       data elements (calibration)
Interface:
    'interface' kind=InterfaceKind name=ID '{' (members+=InterfaceMember)* '}';

InterfaceKind returns string:
    'sr' | 'cs' | 'mode' | 'nv' | 'param';

InterfaceMember:
    DataElement | Operation | ModeGroup;

// `Value: uint16` or `Value: uint16[4]`.
DataElement:
    name=Name ':' type=TypeRef;

// `GetValue(in id: uint16, out value: uint32): Std_ReturnType`.
Operation:
    name=Name '(' (arguments+=Argument (',' arguments+=Argument)*)? ')' (':' returnType=TypeRef)?;

Argument:
    direction=ArgumentDirection name=Name ':' type=TypeRef;

ArgumentDirection returns string:
    'in' | 'out' | 'inout';

// `modes STARTUP, RUN, SHUTDOWN`.
ModeGroup:
    'modes' modes+=ModeDeclaration (',' modes+=ModeDeclaration)*;

ModeDeclaration:
    name=Name;

// Data types are plain text (`uint8`, `Std_ReturnType`, `uint16[4]`).
// ARDL describes the architecture; it does not check implementation data types.
TypeRef returns string:
    Name ('[' INT ']')?;

// ---------------------------------------------------------------- components

// Everything that has ports and can be instantiated in a composition.
Component:
    Swc | Bsw | Composition;

// Atomic software component, e.g. `swc application LightCtrl { ... }`.
Swc:
    'swc' kind=SwcKind name=ID ComponentBody;

SwcKind returns string:
    'application' | 'sensorActuator' | 'service' | 'ecuAbstraction' | 'complexDriver' | 'parameter';

// Basic software module with its layer and the modules it calls:
// `bsw NvM layer services uses MemIf { ... }`. The body is optional, because
// most BSW modules only matter for the layers view.
Bsw:
    'bsw' name=ID 'layer' layer=BswLayer
    ('uses' uses+=[Bsw:ID] (',' uses+=[Bsw:ID])*)?
    ComponentBody?;

BswLayer returns string:
    'services' | 'ecual' | 'mcal' | 'cdd';

// Ports and runnables in any order.
fragment ComponentBody:
    '{' (ports+=Port | runnables+=Runnable)* '}';

// `pport PpLamp : LampState`. P = provided, R = required, PR = both.
Port:
    direction=PortDirection name=Name ':' interface=[Interface:ID];

PortDirection returns string:
    'pport' | 'rport' | 'prport';

// `runnable R_Control every 10ms reads RpSpeed writes PpLamp`.
// Triggers (RTE events) and accesses (RTE API calls) can be mixed freely.
Runnable:
    'runnable' name=Name (triggers+=Trigger | accesses+=Access)*;

Trigger:
    TimingTrigger | InitTrigger | DataTrigger | OperationTrigger | ModeTrigger;

// TimingEvent.
TimingTrigger:
    'every' period=DURATION;

// InitEvent. The {infer ...} action creates the node although it has no properties.
InitTrigger:
    {infer InitTrigger} 'on' 'init';

// DataReceivedEvent on a required sender-receiver port.
DataTrigger:
    'on' 'data' port=[Port:Name];

// OperationInvokedEvent on a provided client-server port (the server runnable).
OperationTrigger:
    'on' 'call' port=[Port:Name];

// SwcModeSwitchEvent on a required mode port.
ModeTrigger:
    'on' 'mode' port=[Port:Name];

// `reads A, B` / `writes P` / `calls Client` / `switches ModePort`.
Access:
    kind=AccessKind ports+=[Port:Name] (',' ports+=[Port:Name])*;

AccessKind returns string:
    'reads' | 'writes' | 'calls' | 'switches';

// ---------------------------------------------------------------- compositions

// A composition has its own (delegation) ports, prototypes of other
// components, and connectors between them.
Composition:
    'composition' name=ID '{' (ports+=Port | prototypes+=Prototype | connectors+=Connector)* '}';

// `prototype LightCtrl` or `prototype nvm: NvM`.
// Without a name the prototype is named after its type (see ArdlNameProvider).
Prototype:
    'prototype' (name=Name ':')? type=[Component:ID];

// `connect SpeedCalc.PpSpeed -> LightCtrl.RpSpeed` (assembly) or
// `connect OutsideTemp -> LightCtrl.RpOutsideTemp` (delegation).
Connector:
    'connect' source=PortRef '->' target=PortRef;

// `proto.Port` or, for a port of the enclosing composition, just `Port`.
PortRef:
    (prototype=[Prototype:Name] '.')? port=[Port:Name];

// ---------------------------------------------------------------- operating system

// The OS of an ECU: tasks, ISRs and the objects they synchronize and
// communicate through. The profile (`autosar`, `osek`, `threadx`, `freertos`,
// `generic`) is a plain identifier; the validator says which objects and
// protocols a profile supports. Names inside an `os` block are local to it.
Os:
    'os' name=ID ('profile' profile=ID)? '{' (tasks+=Task | isrs+=Isr | objects+=OsObject)* '}';

// `task Task_10ms prio 10 every 10ms runs LightCtrl.R_Control locks NvmLock`.
// Like a runnable, the clauses come in any order and may span several lines.
Task:
    'task' name=ID (
        'prio' priority=INT
        | 'core' core=INT
        | 'every' period=DURATION
        | 'on' startup?='startup'
        | 'runs' runs+=RunnableRef (',' runs+=RunnableRef)*
        | accesses+=OsAccess
    )*;

// `isr CanRxIsr cat 2 sets CanRx`. Category 1 ISRs must not use OS objects.
Isr:
    'isr' name=ID (
        'prio' priority=INT
        | 'core' core=INT
        | 'cat' cat=INT
        | accesses+=OsAccess
    )*;

// Runnable-to-task mapping: `LightCtrl.R_Control` or `NvM.NvM_MainFunction`.
RunnableRef:
    component=[RunnableOwner:ID] '.' runnable=[Runnable:Name];

type RunnableOwner = Swc | Bsw;

// How a task or ISR uses an OS object. `locks A, B` takes B while A is held,
// which is the lock order the deadlock check works on.
OsAccess:
    kind=OsAccessKind objects+=[OsObject:ID] (',' objects+=[OsObject:ID])*;

OsAccessKind returns string:
    'locks' | 'takes' | 'gives' | 'sends' | 'receives' | 'waits' | 'sets';

OsObject:
    Mutex | Semaphore | Queue | Event;

// `protocol inherit | ceiling | none`; without it the profile's default
// (ceiling for autosar/osek, inherit otherwise).
Mutex:
    'mutex' name=ID ('protocol' protocol=ID)?;

Semaphore:
    'semaphore' name=ID ('count' count=INT)?;

// Message queue (ThreadX/FreeRTOS) or IOC channel (AUTOSAR).
Queue:
    'queue' name=ID ('of' type=TypeRef)? ('depth' depth=INT)?;

Event:
    'event' name=ID;

// ---------------------------------------------------------------- views

// Views select what the preview and the CLI render. All of them share the
// `view <name>` prefix; the keyword after the name decides the kind.
View:
    CompositionView | ComponentView | LayersView | OsView;

// Internal structure of a composition.
CompositionView:
    'view' name=ID 'composition' composition=[Composition:ID] ('title' title=STRING)?;

// One component with its ports and runnables.
ComponentView:
    'view' name=ID 'component' component=[Component:ID] ('title' title=STRING)?;

// BSW layered architecture; without a list it shows every BSW module of the workspace.
LayersView:
    'view' name=ID 'layers' ('{' modules+=[Bsw:ID] (',' modules+=[Bsw:ID])* '}')? ('title' title=STRING)?;

// Tasks, ISRs and OS objects of one `os`, with the mapped runnables.
OsView:
    'view' name=ID 'os' os=[Os:ID] ('title' title=STRING)?;

// ---------------------------------------------------------------- terminals

// Names of ports, runnables and members. Besides plain identifiers they may
// reuse soft keywords, so a data element can be called `data` or `mode`.
Name returns string:
    ID | 'data' | 'init' | 'call' | 'mode' | 'modes' | 'layer' | 'title' | 'in' | 'out' | 'inout'
    | 'core' | 'count' | 'depth' | 'event' | 'queue' | 'prio' | 'protocol' | 'startup' | 'cat' | 'of';

hidden terminal WS: /\s+/;
// Must come before INT: the lexer takes the first terminal that matches, and
// `10ms` would otherwise be lexed as INT followed by the identifier `ms`.
terminal DURATION: /[0-9]+(\.[0-9]+)?(ms|us|s)\b/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
