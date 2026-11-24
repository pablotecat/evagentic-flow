# Lector independiente y semántica conservadora de evidencia

`scripts/inspect.mjs` y el lector de las pruebas consumen el contrato JSONL
documentado, sin importar el plugin, abrir la base de datos ni requerir un servidor
OpenCode. Así pueden verificar y consultar evidencia incluso cuando falla el
registrador. Una identidad de sesión ausente o excluida no convierte una fila de
sesión en evidencia global; solo los diagnósticos globales explícitos lo son.

Las duraciones representan intervalos observados, no identidades causales
inventadas ni totales facturables. Se compara el orden público dentro de la misma
identidad de paso, no nombres de archivo ni relojes locales de observación. El
inbox pendiente es propio de la sesión; una entrega no acredita aceptación ni
éxito. Repetir hooks de admisión para el mismo identificador público de mensaje
tampoco acredita admisiones distintas. Una carga omitida o desconocida nunca
aporta por sí sola evidencia terminal de éxito.

El consumo publicado por el runtime, incluso cero, no prueba consumo medido del
proveedor. Del mismo modo, `tool.executed: false` no demuestra que no se ejecutara
el ejecutor local. En 2.1.2, Code Mode puede terminar como `session.tool.success`
con `metadata.error: true`; se conserva ese error como desenlace, no se fuerza un
evento `session.tool.failed` que no fue observado.

El papel `output` de un entregable describe su frontera de herramienta: no prueba
producción ni finalidad global. `--deliverables` selecciona solo la sesión
indicada, mientras `--coverage` y `--metrics` incluyen sus descendientes conocidos.
Para comprobar entregables de varias sesiones se consulta la captura sin filtro
o cada sesión, no se presupone selección de árbol.

Origen: comentarios de `scripts/inspect.mjs` y de sus consumidores en las pruebas;
véase la [auditoría](../comment-audit.md). Su acumulación actual en memoria es
[deuda pendiente](https://github.com/pablotecat/evagentic-flow/issues/19), no una
decisión de arquitectura aceptada.
