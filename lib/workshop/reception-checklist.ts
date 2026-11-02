/** Casillas de la recepción digital: id del campo → categoría y etiqueta del checklist. */
export const RECEPTION_CHECKLIST = [
  { id: "chk_lights", category: "INTAKE", label: "Luces de tablero encendidas" },
  { id: "chk_spare", category: "INVENTORY", label: "Llanta de repuesto y gata" },
  { id: "chk_radio", category: "INVENTORY", label: "Radio y accesorios" },
  { id: "chk_docs", category: "INVENTORY", label: "Documentos del vehículo" },
  { id: "chk_scratch", category: "DAMAGE", label: "Rayones o abolladuras" },
  { id: "chk_glass", category: "DAMAGE", label: "Lunas rotas o rajadas" },
] as const;
