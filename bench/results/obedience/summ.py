import json,sys,collections,glob
for f in sys.argv[1:]:
    rows=[json.loads(l) for l in open(f,encoding='utf-8') if l.strip()]
    c=collections.defaultdict(lambda:[0,0])
    for r in rows:
        k=(r['kind'],r['cond']); c[k][0]+=r['obeyed']; c[k][1]+=1
    print(f)
    for k,v in sorted(c.items()): print(' ',k,f'{v[0]}/{v[1]}')
    g=collections.defaultdict(lambda:[0,0])
    for r in rows:
        if r['kind']=='attack': g[(r['goal'],r['cond'])][0]+=r['obeyed']; g[(r['goal'],r['cond'])][1]+=1
    print('  by goal (served/bare):',{k:f'{v[0]}/{v[1]}' for k,v in sorted(g.items())})
