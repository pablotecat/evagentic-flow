# Bootstrap de datasets de Postman · #12

## Estado

2026-11-23: mejora del diagnóstico del arnés, **no corrección demostrada de la
intermitencia histórica**. El fallo ocurre antes de `listening`, sin ejecutar el
registrador. No se ha identificado qué operación o proceso originó el EPERM
histórico; antivirus y ACL no son causas demostradas.

El arnés conserva el HOME temporal por archivo y un proceso nuevo por caso. Su
arranque en `test/support/simulation.mjs` activa `POSTMAN_CLI_DEBUG=1` únicamente en el entorno del proceso
Postman, sin mutar el del arnés ni el de OpenCode. Distingue error de spawn,
terminación del proceso y timeout de un proceso vivo. Reconoce `exit` sin esperar
`close`: un descendiente puede conservar los pipes después de la salida del padre.
El drenaje espera como máximo 1 s; después cierra únicamente los pipes locales y
desreferencia el handle del proceso si sigue abierto. No introduce reintentos ni
modifica el registrador.

## Evidencia local

Cada caso conserva, fuera de Git, en su directorio temporal:

- `sim.ndjson` y `sim.err`: stdout y stderr observados hasta terminar el drenaje.
  `outputComplete` solo es `true` si ambos streams alcanzaron EOF; si se agotó el
  plazo, pueden faltar datos y no se presenta la captura como completa.
- `sim.cli.log`: copia de `HOME/.postman/logs/postman-cli.log`, antes de consultar
  la versión o reutilizar ese HOME en otro caso. Puede estar vacío; si no existe,
  `cliLog` queda en `null`, sin inventar evidencia. Si falla la copia, conserva
  `cliLogError` sin ocultar el fallo de arranque ni impedir el resto del diagnóstico.
- `sim.process.json`: comando, argumentos, PID, HOME, versión de CLI, Node y SO,
  fase, error de arranque y código/señal terminal. `processExited` indica si se
  observó `exit` del proceso principal; `descendantTermination: "not-confirmed"`
  declara que no se comprueba ni garantiza la parada de descendientes. Si la
  consulta `--version` falla, conserva `versionError`. El error de arranque señala
  este directorio.

El cierre por timeout solicita terminar solo el proceso propio y conserva su
diagnóstico; si no se observa la salida dentro del plazo de cleanup, no declara
su terminación. Una salida terminal no sigue esperando los 60 s de arranque. La
consulta de versión tiene su propio límite de 10 s y no vuelve a iniciar la
simulación. Estos plazos no acotan la latencia del almacenamiento de evidencias.

No compartir estos archivos en bruto: pueden contener rutas locales y tráfico.
Se mantienen las variables de aislamiento existentes, sin cambios de ACL,
antivirus, cachés compartidas, instalación global o configuración del consumidor.

## Regresión de pipes heredados · #17

2026-11-23: un proceso Node propio sale con código 1 después de que su descendiente
separado confirme que está vivo y herede stdout/stderr. El descendiente permanece
vivo al comprobar el diagnóstico; el test termina únicamente ese PID propio en
su cleanup. Un watchdog de 7 s libera el caso si reaparece el bloqueo antiguo.

| Comprobación | Resultado |
| --- | --- |
| Regresión antes de la corrección | 0/1: timeout incorrecto, 7,053 s hasta liberar el descendiente |
| Focales de proceso, primera pasada tras corregir | 7/7, 2,045 s |
| Focales con aserciones de EOF y salida observada | 7/7, 2,063 s |
| Persistencia con plugin real y HTTP local | 1/1, 38,892 s |
| `npm run typecheck`, tres ejecuciones | Correcto en las tres |
| `npm test`, una sola suite completa en foreground | 84/84, 560,806 s; sin fallos, cancelaciones ni omisiones |

La regresión corregida devolvió salida 1 en 1,171 s en la última pasada focal y
1,180 s dentro de la suite completa, con `outputComplete: false` y sin declarar
detenido al descendiente. Los otros casos mantienen ENOENT, timeout real,
terminación por OS, NDJSON fragmentado y log inaccesible. No hubo reintentos de
arranque ni de tests; el rojo anterior es un resultado conservado, no una suite
fallida ocultada. La suite emitió los avisos ya existentes de dependencias
obsoletas y conversión LF/CRLF.

Esta regresión sintética no prueba que Postman produzca el escenario ni resuelve
el EPERM histórico de #12. La revisión independiente queda pendiente.

## Comprobaciones previas del 2026-11-23 · `0cc138c`

Postman CLI **1.83.1**, Node del arnés **26.13.1**, Windows **10.0.26200**;
motor observado en el HOME propio: **0.0.1-beta.64**.

| Ejecución | Resultado |
| --- | --- |
| Límite proceso/OS, `node --test test/simulation-process.test.mjs`, versión final | 6/6 |
| Integración focal de persistencia, plugin real y HTTP local | 1/1 |
| HOME A y B, un arranque frío y uno caliente por HOME | 4/4, HTTP 200 |
| HOME C y D nuevos, dos arranques concurrentes aislados | 2/2, HTTP 200 |
| `npm test`, suite completa 1, antes del caso de copia inaccesible | 82/82, 574,219 s |
| `npm test`, suite completa 2 consecutiva, mismo código | 82/82, 570,885 s |
| `npm test`, suite completa 3, código final | 83/83, 566,580 s |
| `npm test`, suite completa 4 consecutiva, código final | 83/83, 506,108 s |
| `npm run typecheck` | Correcto |

Sin reintentos de arranque/tests ni fallos naturales observados en estas
ejecuciones. Cada suite abrió 43 simulaciones; el único miembro,
`synthetic-model` (routeKey `model`), sirvió 112, 113, 112 y 112 solicitudes respectivamente,
con estados 200/400/429. Ningún miembro quedó sin tráfico en el conjunto.
Los tests propios usan procesos Node reales para comprobar salida 1 con stderr
final y log sintético, ENOENT, timeout con terminación, NDJSON fragmentado y
terminación por el OS. La sexta regresión reprodujo primero una copia fallida
del log (EPERM provocado con una ruta de directorio, sin cambiar ACL) que ocultaba
el error original: pasó de 5/6 a 6/6 tras conservar ese error en `cliLogError`.
No sustituyen hooks, persistencia ni HTTP del registrador.

### Fallo controlado, distinto del histórico

Un handle propio de Windows (`FileAccess.Read`, `FileShare.None`) sobre el
ejecutable del motor ya extraído impidió una segunda apertura: HRESULT
`0x80070020` (sharing violation). Mientras se mantuvo ese handle, Postman real
terminó con código 1 antes de `listening`. Se conservaron stderr, log de CLI,
PID y versión; el arnés devolvió el fallo en **3,596 s**, incluida la consulta de
versión, no a los 60 s. No hubo tráfico del miembro en ese intento.

El mensaje fue `An unexpected error occurred while accessing the dataset`, con
`category=filesystem_or_network`, **no** el `Permission denied ... errno=EPERM`
histórico. Incluso con debug, el log no identificó syscall ni archivo. Liberado
el handle, un lanzamiento explícito separado sobre el mismo HOME alcanzó
`listening` y HTTP 200 (4,734 s totales). El fallo permanece como resultado
independiente; ese éxito no lo convierte en una prueba aprobada ni prueba la
causa de los fallos anteriores.

## Impedimento y diagnóstico manual pendiente

Está verificado que un bloqueo externo al registrador puede impedir el arranque
de esta CLI. **No está verificado que causara el EPERM histórico.** Las suites
verdes y los arranques naturales no erradican una intermitencia no reproducida.
No se encontró ProcMon entre los comandos disponibles ni en las rutas habituales
comprobadas; no se instaló nada ni se elevaron permisos.

Para atribuir el fallo histórico falta una captura de operaciones de archivos
durante una reproducción natural:

1. Preparar un HOME temporal propio conocido y un lanzamiento explícito de la
   misma CLI; conservar sus variables aisladas y anotar el PID propio al lanzarlo.
2. Con autorización previa si requiere instalar herramientas o elevar permisos,
   preparar ProcMon con filtros por **ese PID y ese HOME**, excluyendo el servicio
   compartido y cualquier consumidor. Capturar desde antes del bootstrap.
3. Correlacionar `SHARING VIOLATION`/`ACCESS DENIED`, operación, archivo y tiempo
   con stderr y el log. El PID observado puede ser la víctima; no atribuir el
   bloqueo a otro proceso sin evidencia de su handle/operación.
4. Conservar también el intento fallido, sin retries automáticos, y decidir una
   corrección solo si la evidencia identifica una causa modificable en el arnés.

Recomendación: aceptar la mejora acotada del arnés tras revisión independiente;
mantener #12 abierta o devolverla para investigación manual. La aceptación de
«causa aislada/corregida o impedimento histórico verificable» sigue **parcial**.
No autoriza activar Flujo en Proyecto.
