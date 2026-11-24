# Guardia durable y parada conservadora ante fallos

`src/index.ts` arma el bloqueo durable **antes** de declarar preparada la captura;
solo una limpieza sana lo retira. Escribir el diagnóstico del fallo no debe
desarmarlo: el mismo disco averiado puede impedir registrar su propia avería.
Se reabre el diario existente sin crearlo de nuevo en cada escritura para
detectar evidencia perdida, también en Windows, y se sincroniza cada evento.
Se prefiere durabilidad a rendimiento; agrupar escrituras requeriría decidir
explícitamente qué ventana de pérdida se acepta.

Una configuración inválida no autoriza interrupciones de otras sesiones. La
suscripción puede cruzar proyectos: se verifican ubicación del evento e identidad
y ubicación de la sesión, no solo el contexto del plugin. El identificador
`global` de formularios es un centinela de autenticación/MCP y se excluye de la
captura de sesiones.

La parada vuelve a enumerar después de cada oleada porque pueden aparecer
descendientes durante la comprobación. Incluso después de una exploración sin
novedades, la suscripción conserva la observación de identidades e interrumpe
sesiones autorizadas nuevas aunque falle la escritura. El fallo al añadir una
fila `recorder.failed` se tolera sin terminar esa vigilancia. Durante la limpieza
solo se admite el `AbortError` de cancelación; una adquisición o escritura en
curso que falle después de abortar sigue siendo una avería. Se comprueba de nuevo
el estado tras las escrituras de preparación para cubrir carreras con el stream.

En OpenCode 2.1.2, fallar `setup` no veta por sí solo la admisión. Se conservan
registrados los hooks de rechazo, aunque el runtime publique el plugin como
`active`: ese estado acredita la guardia, no una captura preparada. Un hook que
rechaza devuelve HTTP 500 sin cuerpo tipado; el diagnóstico público está en la
sesión. Reparar el destino o recargar no acredita revisión ni permite reanudar.

Origen: comentarios de `src/index.ts`, `test/delegation.test.mjs` y
`test/recorder.test.mjs`, enumerados en la [auditoría](../comment-audit.md).
