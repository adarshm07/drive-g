import bpy, sys
src, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src, use_scripts=False)
root = bpy.data.objects.get('Movement Control')
keep = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == root]
for o in list(bpy.data.objects):
    if o not in keep and o != root:
        bpy.data.objects.remove(o, do_unlink=True)
DECIMATE = {'Lower Grille': 0.05, 'Upper Grille': 0.05}
for o in keep:
    for m in o.modifiers:
        if m.type == 'SUBSURF':
            m.levels = m.render_levels = 1
    ratio = DECIMATE.get(o.name, 0.22 if 'tire' in o.name.lower() else None)
    if ratio:
        d = o.modifiers.new('dec', 'DECIMATE'); d.ratio = ratio
    for p in o.data.polygons: p.use_smooth = True
    o.hide_viewport = o.hide_render = False
    o.hide_set(False)
    o.name = o.name.strip().strip('.').replace('  ', ' ')
# simple materials: the game restyles them by name
for m in bpy.data.materials:
    m.use_nodes = False
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_cameras=False, export_lights=False,
                          export_texcoords=False, export_animations=False, export_yup=True, export_materials='EXPORT')
dg = bpy.context.evaluated_depsgraph_get()
tot = 0
for o in keep:
    me = o.evaluated_get(dg).to_mesh(); me.calc_loop_triangles(); tot += len(me.loop_triangles)
    print(o.name, len(me.loop_triangles), [s.material.name for s in o.material_slots if s.material])
print('TOTAL TRIS', tot)
