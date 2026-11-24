# Pruebas aisladas en fronteras públicas

Las pruebas del registrador usan procesos reales aislados y fronteras públicas,
no sustitutos del registrador ni de OpenCode. El proveedor HTTP sintético no
utiliza proveedor real, credenciales ni datos de negocio. Su observación de la
petición despachada es independiente del hook anterior del registrador: permite
demostrar que un hook posterior cambió el contexto sin atribuir a la captura
el contexto final del transporte.

La instancia declara su home temporal y desactiva el descubrimiento de fuentes
de ancestros: V2 busca fuentes de compatibilidad incluso por encima de la raíz
Git, y el temporal puede vivir bajo el home real. Las rutas de home, datos,
configuración, caché, estado y base de datos se verifican **antes** de abrir la
base de datos o iniciar OpenCode. Se comparte solo el bootstrap de la CLI de
simulación en un home temporal; cada simulación mantiene proceso y estado nuevos.

Las carreras se provocan mediante plugins reales: uno posterior al registrador
demora la admisión; otro crea un descendiente al observar el aviso público. Para
averiar la persistencia se altera la frontera real del sistema de archivos y se
conserva la evidencia original. La prueba de ruta perdida elimina únicamente el
alias sintético, no los datos observados. El cierre abrupto usa la frontera de
proceso aislado para impedir que un callback privado de fallo resuelva el caso.
Antes de copiar diarios sin alterar sus bytes se cierran por el ciclo de vida
público, evitando comparar archivos todavía abiertos a escritura.

El ayudante de simulación controla solo el proceso de simulación. Un descendiente
puede retener stdout/stderr después de salir el padre, por lo que salida del
proceso y cierre de pipes son hechos distintos. La regresión libera exclusivamente
su descendiente mediante un watchdog aunque reaparezca una espera infinita de
`close`. Las respuestas NDJSON se analizan solo al completar la línea, pues una
escritura puede llegar dividida en varios chunks.

Origen: comentarios de `test/support/`, `test/simulation-process.test.mjs`,
`test/definitions.test.mjs`, `test/metrics.test.mjs`, `test/recorder.test.mjs`,
`test/tools.test.mjs` y el encabezado del proveedor sintético; véase la
[auditoría](../comment-audit.md). El presupuesto de reintentos inferido del prompt
queda como [deuda independiente](https://github.com/pablotecat/evagentic-flow/issues/18).
