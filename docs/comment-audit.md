# Auditoría de comentarios

Base: `75056d36e2dd36c6d1386a7cedd4bd8ed50bd5c5`. Las ubicaciones y fragmentos
de esta tabla son los anteriores a la limpieza. Cada fila representa un token de
comentario; dos líneas `//` consecutivas cuentan como dos comentarios.

Se revisaron todos los JS/TS y JSON/JSONC propios enumerados por Git y los dos
YAML de simulación. Se excluyeron dependencias, compilados, datos/configuración
local ignorados y repositorios consumidores anidados. La prosa Markdown y sus
marcadores HTML no son comentarios de código y se conservan, incluidos los
cambios previos ajenos a esta revisión.

## Resultado y ahorro

| Categoría | Comentarios | Acción |
| --- | ---: | --- |
| Tautology | 6 | Eliminados |
| Excuse | 2 | Eliminados y deuda publicada |
| Stale | 1 | Eliminado |
| Decision Record | 59 | Trasladados a ADR y eliminados del código |
| Total | 68 | Sin comentarios pendientes; baseline vacío |

Eliminar todos los comentarios ocupa **68 líneas de comentario**, pero solo
**54 líneas completas desaparecen**: los otros 14 comentarios comparten línea
con código que debe conservarse. El ahorro bruto real de esta limpieza es, por
tanto, **54 líneas de código fuente**, no 68. No incluye líneas en blanco,
dependencias ni artefactos generados. Los ADR, el lint, sus pruebas y la skill
añaden líneas nuevas; no se presenta ese ahorro bruto como balance neto del PR.

Destinos de decisiones:
- [ADR-0006](adr/0006-guardia-durable-y-parada-ante-fallos.md): guardia, durabilidad y alcance.
- [ADR-0007](adr/0007-filtrado-estructural-y-limites-de-contenido.md): filtrado y autorización de contenido.
- [ADR-0008](adr/0008-lector-independiente-y-semantica-de-evidencia.md): lector y límites de evidencia.
- [ADR-0009](adr/0009-pruebas-aisladas-en-fronteras-publicas.md): pruebas y procesos aislados.

Deuda publicada: [#18](https://github.com/pablotecat/evagentic-flow/issues/18)
(identidad de reintentos inferida del prompt) y
[#19](https://github.com/pablotecat/evagentic-flow/issues/19)
(memoria del lector sin acotar). El comportamiento se conserva en esta limpieza.

## Clasificación exhaustiva

| Ubicación anterior | Fragmento identificador | Categoría | Motivo / destino |
| --- | --- | --- | --- |
| `postman/mocks/synthetic-model/default.js:1` | Synthetic OpenAI-compatible | Decision Record | Proveedor sintético aislado; ADR-0009 |
| `postman/mocks/synthetic-model/default.js:31` | One budget per primary V2 project context | Excuse | Justifica inferir identidad desde prosa del sistema; #18 |
| `postman/mocks/synthetic-model/default.js:145` | A secret split across chunks | Decision Record | Exclusión de deltas por secretos fragmentados; ADR-0007 |
| `scripts/inspect.mjs:7` | Independent consumer of capture v1 | Decision Record | Frontera de lector independiente; ADR-0008 |
| `scripts/inspect.mjs:47` | missing/excluded session identity | Decision Record | Identidad ausente no implica alcance global; ADR-0008 |
| `scripts/inspect.mjs:152` | observation intervals | Decision Record | Límites causales y de facturación; ADR-0008 |
| `scripts/inspect.mjs:271` | Compare only this public step identity | Decision Record | Orden público en lugar de archivos/relojes locales; ADR-0008 |
| `scripts/inspect.mjs:315` | Pending inbox work is session-scoped | Decision Record | Entrega no acredita aceptación; ADR-0008 |
| `scripts/inspect.mjs:423` | buffers the capture; add an index | Excuse | Aplaza resolver memoria proporcional a toda la captura; #19 |
| `scripts/inspect.mjs:505` | not terminal evidence of success | Decision Record | Omisión no equivale a éxito; ADR-0008 |
| `src/index.ts:163` | failure of THIS write | Decision Record | El fallo del diagnóstico no desarma el bloqueo; ADR-0006 |
| `src/index.ts:167` | Invalid configuration cannot authorize | Decision Record | Configuración inválida no amplía autorización; ADR-0006 |
| `src/index.ts:168` | delegates may appear | Decision Record | Reenumeración ante carreras; ADR-0006 |
| `src/index.ts:169` | after a quiet scan too | Decision Record | Vigilancia posterior a la primera parada; ADR-0006 |
| `src/index.ts:239` | Arm durably BEFORE | Decision Record | Bloqueo previo y limpieza sana; ADR-0006 |
| `src/index.ts:255` | Do not recreate missing evidence | Decision Record | Detectar destino perdido también en Windows; ADR-0006 |
| `src/index.ts:260` | fsync per event favors evidence | Decision Record | Durabilidad frente a rendimiento; ADR-0006 |
| `src/index.ts:283` | Ordinary text, not JSON | Tautology | Repite el fallo de JSON.parse y su fallback textual |
| `src/index.ts:290` | Re-filtering its serialization | Decision Record | No destruir JSON ya filtrado; ADR-0007 |
| `src/index.ts:421` | stream can cross projects | Decision Record | Contexto del plugin no autoriza por sí solo; ADR-0006 |
| `src/index.ts:425` | Authentication/MCP sentinel | Decision Record | Identidad global no es una sesión; ADR-0006 |
| `src/index.ts:609` | Continue observing identities | Decision Record | La avería del disco no termina vigilancia; ADR-0006 |
| `src/index.ts:614` | Only cancellation of the subscription | Decision Record | Cancelación esperada, no toda avería posterior al abort; ADR-0006 |
| `src/index.ts:615` | acquisition/write can fail AFTER abort | Decision Record | Continuación del criterio de avería anterior; ADR-0006 |
| `src/index.ts:619` | A failed disk cannot be relied on | Decision Record | Diagnóstico y bloqueo no dependen del disco averiado; ADR-0006 |
| `src/index.ts:633` | Explicit local contract | Decision Record | Único argumento de ruta autorizado; ADR-0007 |
| `src/index.ts:634` | Never parse command text | Decision Record | Excluir heurísticas de rutas sobre prosa y parches; ADR-0007 |
| `src/index.ts:666` | Do not serialize reasoning | Decision Record | Frontera de privacidad del contexto; ADR-0007 |
| `src/index.ts:731` | Subscription failure can race | Decision Record | Revalidar preparación después de escribir; ADR-0006 |
| `src/index.ts:757` | failed setup is not an admission veto | Decision Record | Compatibilidad de la guardia con 2.1.2; ADR-0006 |
| `src/index.ts:758` | active means the safety guard runs | Decision Record | Estado activo no acredita captura sana; ADR-0006 |
| `src/index.ts:848` | redacted discriminator/key | Decision Record | Omitir en vez de inventar otro desenlace; ADR-0007 |
| `src/index.ts:859` | preserves the validated structure | Decision Record | Justificación de la conversión tipada tras filtrar; ADR-0007 |
| `src/index.ts:891` | escaped literals must not bypass | Decision Record | Decodificar antes de filtrar secretos; ADR-0007 |
| `src/index.ts:1001` | discriminators must still attest | Decision Record | Integridad semántica de la proyección; ADR-0007 |
| `src/index.ts:1019` | scalar whose JSON type changes | Decision Record | Proyecciones tipadas rechazan cambios de tipo; ADR-0007 |
| `src/index.ts:1046` | Cookie values span semicolons | Decision Record | Excluir cabecera completa y continuaciones; ADR-0007 |
| `test/definitions.test.mjs:159` | provider is independent | Decision Record | Evidencia de transporte independiente del hook; ADR-0009 |
| `test/delegation.test.mjs:53` | retried public message ID | Decision Record | Hooks repetidos no duplican admisión; ADR-0008 |
| `test/delegation.test.mjs:110` | after its initial scan | Decision Record | Regresión de vigilancia tras fallo; ADR-0006 |
| `test/deliverables.test.mjs:221` | Role at this tool boundary | Decision Record | Papel de salida no acredita producción/finalidad; ADR-0008 |
| `test/metrics.test.mjs:185` | before copying their unchanged bytes | Decision Record | Cerrar por ciclo público antes de copiar; ADR-0009 |
| `test/metrics.test.mjs:215` | NOT measured provider consumption | Decision Record | Cero del runtime no equivale a medición; ADR-0008 |
| `test/pilot.test.mjs:50` | Second pass changes ONLY | Tautology | Repite el spread y los dos campos sustituidos |
| `test/pilot.test.mjs:63` | last real event subscriber | Stale | No es la última suscripción: el registrador mantiene la suya; se cierra el cliente |
| `test/pilot.test.mjs:112` | deliverables is session-scoped | Decision Record | Asimetría de selección sesión/árbol; ADR-0008 |
| `test/pilot.test.mjs:143` | confined to this isolated instance | Tautology | Las operaciones ya usan instance y su destino temporal |
| `test/recorder.test.mjs:36` | No event client, browser or export | Tautology | Repite el nombre y la preparación visible de la prueba sin cliente |
| `test/recorder.test.mjs:137` | hook must remain active | Decision Record | Guardia activa aunque falle preparación; ADR-0006 |
| `test/recorder.test.mjs:157` | real filesystem boundary | Decision Record | Inyección en frontera pública preservando evidencia; ADR-0009 |
| `test/recorder.test.mjs:175` | without a typed/public response body | Decision Record | Rechazo público de hooks en 2.1.2; ADR-0006 |
| `test/recorder.test.mjs:177` | reloading is not a review | Decision Record | Reparación no autoriza reanudar; ADR-0006 |
| `test/recorder.test.mjs:218` | Code Mode reports a completed tool | Decision Record | Evento success puede conservar error:true; ADR-0008 |
| `test/recorder.test.mjs:256` | public deletion removes the object | Tautology | Repite la llamada DELETE que sigue y el caso descrito por la prueba |
| `test/recorder.test.mjs:278` | only the synthetic alias | Decision Record | Evitar eliminar el proyecto observado; ADR-0009 |
| `test/recorder.test.mjs:316` | no recorder failure callback can run | Decision Record | Cierre en frontera de proceso, no callback privado; ADR-0009 |
| `test/simulation-process.test.mjs:49` | only this case's descendant | Decision Record | Watchdog acotado frente a regresión de pipes; ADR-0009 |
| `test/support/instance.mjs:70` | above Git roots too | Decision Record | Descubrimiento ancestral exige aislamiento explícito; ADR-0009 |
| `test/support/instance.mjs:169` | admission AFTER the recorder hook | Decision Record | Carrera mediante segundo plugin real; ADR-0009 |
| `test/support/instance.mjs:187` | descendant in reaction to | Tautology | Resume la suscripción y ctx.session.create inmediatamente visibles |
| `test/support/instance.mjs:216` | Cache only CLI bootstrap | Decision Record | Caché compartida sin compartir estado del mock; ADR-0009 |
| `test/support/instance.mjs:232` | before opening a database | Decision Record | Aislamiento probado antes de efectos persistentes; ADR-0009 |
| `test/support/instance.mjs:276` | independent consumer | Decision Record | Pruebas contra JSONL, no internals; ADR-0008 |
| `test/support/simulation.mjs:10` | Only the simulation process boundary | Decision Record | Sin sustitutos de OpenCode/registrador; ADR-0009 |
| `test/support/simulation.mjs:22` | pipes open after the main process exits | Decision Record | Diferenciar exit de close; ADR-0009 |
| `test/support/simulation.mjs:58` | partial NDJSON line | Decision Record | Analizar solo registros completos; ADR-0009 |
| `test/tools.test.mjs:78` | Runtime flag, not proof | Decision Record | Semántica limitada de executed; ADR-0008 |
| `test/tools.test.mjs:200` | Public process boundary | Decision Record | Parada real en vez de colaborador privado; ADR-0009 |
