# Preparación aislada · Flujo en Proyecto (#9)

**Este procedimiento no instala, activa, recarga ni reinicia el consumidor o su
servicio compartido. Un resultado satisfactorio solo verifica la instancia
temporal: el servidor real no está comprobado y el refinamiento real sigue
pendiente de autorización y validación funcional posteriores.**

## Repetir la preparación

Desde este repositorio, con Node >=22, npm, Git, OpenCode **2.1.2** y Postman CLI
**1.83.1** disponibles (sin credenciales de modelos):

```sh
npm ci
npm run typecheck
npm run verify:pilot
npm test
```

`verify:pilot` ejecuta `test/pilot.test.mjs`; no reemplaza las pruebas de cada
corte. `npm test` las conserva y ejecuta también la comprobación integrada.
Ambos comandos terminan en primer plano con resultado visible; no reintentan
casos fallidos. No interpretar una repetición posterior como si borrase un fallo.
`OPENCODE_TEST_BIN` permite seleccionar un binario explícito; `OPENCODE_TEST_TMP`
permite elegir el directorio temporal existente. No usar rutas del consumidor.

El arnés reutilizado en `test/support/instance.mjs`:

1. Ejecuta **`npm pack --json --pack-destination <temporal>`** (su `prepack`
   compila el código actual), e instala ese `.tgz` con `npm install --offline
   --ignore-scripts --omit=dev --no-audit --no-fund --prefix <temporal> <tgz>`.
   Es una instalación real, no un enlace al workspace. Si la caché npm no tiene
   las dependencias, falla visiblemente: preparar la caché mediante `npm ci`
   antes de la prueba; no sustituirla por una copia enlazada. No se publica nada.
2. Crea dos repositorios sintéticos y separa HOME, configuración, plugins,
   caché, estado, base de datos y capturas. Desactiva descubrimiento de ancestros;
   comprueba `opencode debug paths` **antes** de abrir la instancia. Arranca
   únicamente `opencode serve` en localhost, puerto aleatorio y contraseña
   sintética; nunca descubre, arranca ni utiliza el servicio compartido.
3. Conserva agentes, skills, permisos y otros plugins sintéticos existentes.
   Añade un **nuevo** archivo de entrada con creación exclusiva; no sustituye
   `opencode.json`, arrays de plugins ni personalizaciones. Se comprueban bytes
   de configuración/definiciones, agente y permisos públicos y plugins activos.
4. Comprueba `/api/info`, plugin activo, `recorder.ready`, versiones realmente
   observadas y una captura legible. `active` por sí solo no basta: también puede
   representar el guardián de un registrador averiado. La admisión y persistencia
   reales prueban las capacidades V2, no solo un número de versión o typecheck.
5. Ejecuta un árbol con delegación anidada y ramas concurrentes y sesiones hijas
   de herramientas, fallo/recuperación, reintento de modelo, pregunta y aprobación
   contestadas por cliente externo, carga de skill, procedencia, escritura/lectura
   nativas, métricas y finalización. Usa exclusivamente APIs/herramientas públicas
   y los lectores independientes incluidos en el paquete instalado.
6. Conecta un suscriptor público de eventos y lo desconecta durante el trabajo.
   Comprueba persistencia posterior sin ese cliente. Excluye otro proyecto del
   mismo servidor y los secretos sintéticos conocidos del caso.
7. Repite la preparación y las comprobaciones seleccionando el **otro proyecto**
   y un destino nuevo mediante `recorder.local.json`: solo cambian
   `projectDirectory` y `captureDirectory`. Los proyectos, código instalado,
   agentes, skills y configuración de OpenCode permanecen iguales. Solo recarga
   las ubicaciones **temporales** para releer la configuración.
8. Finaliza el proceso aislado y consulta de nuevo los diarios con el lector del
   paquete; la evidencia conservada sobrevive al proceso. Los directorios se
   imprimen en el diagnóstico y permanecen fuera del repositorio para inspección.

El proveedor HTTP sintético usa la simulación existente
`postman/simulations/recorder/recorder.sim.yaml`. La prueba exige tráfico servido
por `model` (POST `/v1/chat/completions`, 200 y 429); no consume modelos reales ni
demuestra su conducta. Los logs `sim.ndjson`, `sim.err`, `sim.cli.log` y
`sim.process.json` permanecen en el directorio temporal. Ante fallo de arranque,
conservarlos y declarar bloqueada la comprobación. **#12 sigue abierta por la
causa histórica EPERM**: su diagnóstico aceptado y la corrección #17 no prueban
erradicación ni autorizan a ocultar fallos posteriores.

## Aviso e interrupción: solo aislados

La fase final de `verify:pilot` provoca indisponibilidad del destino de
captura temporal mientras hay trabajo activo y conserva el diario original.
Consulta título, `metadata.evagenticRecorder` y desenlaces por API pública.
Exige aviso y solicitud de interrupción; comprueba `confirmed` únicamente para
trabajo con desenlace público `interrupted`, y `unconfirmed` para una sesión que
ya no estaba ejecutándose. Comprueba también que el otro proyecto sigue activo
sin aviso ni captura. Después de terminar la instancia vuelve a leer la evidencia.

Esto **no** acredita rollback, parada instantánea ni cancelación de efectos de
servicios externos. No se provocarán fallos en Flujo en Proyecto como condición
del piloto. Un fallo obliga a revisar antes de otra ejecución; reparar el destino
o recargar no retira la marca durable de revisión. Las pruebas previas de
`test/recorder.test.mjs` y `test/delegation.test.mjs` mantienen los casos de
preparación fallida, descendientes tardíos y bloqueo tras cierre sin limpieza.

## Consulta sin otra web ni evaluador

Usar el lector **del paquete instalado**, incluso con el servidor detenido:

```sh
node <paquete-instalado>/scripts/inspect.mjs <captura> --coverage
node <paquete-instalado>/scripts/inspect.mjs <captura> <sesion> --coverage
node <paquete-instalado>/scripts/inspect.mjs <captura> <sesion> --tree
node <paquete-instalado>/scripts/inspect.mjs <captura> <sesion> --tools
node <paquete-instalado>/scripts/inspect.mjs <captura> <sesion> --metrics
node <paquete-instalado>/scripts/inspect.mjs <captura> <sesion> --deliverables
```

Las rutas entre ángulos son marcadores, no comandos literales. Citar rutas con
espacios en el shell. El diagnóstico de la prueba proporciona capturas y sesiones.
La consulta sin modo devuelve las filas originales filtradas por sesión.

`--coverage` distingue **declaraciones** de `recorder.ready` (versiones, fuentes,
capacidades y exclusiones) de tipos/fuentes/etapas/estados **observados**, sus
recuentos, omisiones, diagnósticos y horizonte de cada diario. Con sesión incluye
descendientes relacionados, no otras sesiones ni identidades desconocidas. Los
diagnósticos de registrador son del diario, no fallos imputados a una sesión.
No devuelve porcentaje de evaluación, puntuación ni una aprobación:
`readiness: "not-assessed"`. Un inventario no prueba uso ni evidencia ausente;
un diario vacío tampoco demuestra que el registrador esté sano. Revisar además
los avisos públicos: el fallo del destino puede impedir escribir `recorder.failed`.
Las líneas inválidas o `.pending` producen error, no un informe aparentemente sano.

Límites del [contrato v1](capture-v1.md): sin replay ni identidad causal de
ejecución; orden local de llegada no causalidad; contexto del hook no contexto
final del modelo; respuesta externa sin actor autenticado; disponibilidad no
activación/cumplimiento; enlace de reintento de herramienta no expuesto; uso de
tokens normalizado por runtime, coste estimado y consumo por skill desconocido;
sin suma de duraciones concurrentes; lectura posterior de entregable no versión
histórica garantizada ni resultado final global. No atribuir resultados que
estos límites dejan sin evidencia.

## Privacidad y revisión del entregable

- Solo alias «Flujo en Proyecto» y datos sintéticos en fuentes, nombres, ejemplos,
  fixtures y paquete. El test comprueba la lista permitida del tarball: código
  compilado, manifiesto, README, contrato, esta guía y lector. No incluye tests,
  capturas, `.local`, configuración del consumidor ni simulaciones.
- Revisar `git diff --check`, `git diff` y `npm pack --dry-run --json` antes de
  entregar. Inspeccionar contenido además de nombres, incluyendo `dist/index.js`
  y `.d.ts` generados. No publicar automáticamente el tarball ni las capturas.
  Revisar nombres/rutas absolutas de usuarios/proyectos, URLs privadas y secretos;
  los valores sintéticos de los tests no son credenciales reales.
- Las capturas y artefactos reales y la configuración local quedan fuera de Git
  y del paquete; mantenerlos fuera de cualquier checkout y controlar ACL locales.
  La redacción conocida no es anonimización universal. La revisión de esta entrega
  no afirma borrar referencias de sistemas externos ni del historial.

## Autorización posterior separada (NO ejecutada)

1. Presentar al operador versión/SHA y tarball revisados, resultados exactos,
   fallos (incluido #12), cobertura, límites y estado **servidor real no comprobado**.
   Ninguna issue, publicación o prueba aislada equivale a autorización.
2. Solicitar autorización explícita para **despliegue**: instancia y proyecto
   exactos en configuración local no versionada, destino fuera de Git, retención,
   secretos conocidos/ACL, preservación de personalizaciones y ventana sin trabajo.
   Acordar por separado cualquier recarga/reinicio necesario; no modificar nada
   durante la ejecución en curso ni operar sobre un servicio compartido sin permiso.
3. Tras ese permiso, instalar el `.tgz` en una ubicación local independiente y
   añadir solo la entrada nueva revisada (carga por archivo comprobada en Windows
   2.1.2). No suponer equivalente la entrada de paquete en `plugins` no verificada.
   Documentar lo efectivamente instalado sin cambiar agentes, skills ni permisos.
4. Solicitar autorización explícita de **activación y validación funcional** del
   flujo real. Comprobar allí compatibilidad, alcance, destino, preparación,
   avisos, exclusiones y cobertura sin provocar fallos. Si falta una garantía,
   mantener el piloto bloqueado y pedir revisión. No copiar pruebas destructivas.
5. Solo después de esa autorización y de verificar preparación realizar el
   refinamiento real; consultar captura, versiones y límites antes de juzgarlo.
   Una prueba aislada aprobada no se registrará como validación funcional real.
