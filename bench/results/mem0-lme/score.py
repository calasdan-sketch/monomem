import json,glob,collections,sys
rows=[json.loads(l) for f in glob.glob('D:/mem0-bench/out/full-*.jsonl') for l in open(f,encoding='utf-8') if l.strip()]
ok=[r for r in rows if 'ranked' in r]; err=[r for r in rows if 'error' in r]
print('questions scored',len(ok),'errors',len(err))
for k in (1,3,5,10,20):
    anyk=sum(bool(set(r['ranked'][:k])&set(r['gold'])) for r in ok)
    allk=sum(set(r['gold'])<=set(r['ranked'][:k]) for r in ok)
    print(f'k={k}: any-gold {anyk}/{len(ok)} = {100*anyk/len(ok):.1f}%   all-gold {allk}/{len(ok)} = {100*allk/len(ok):.1f}%')
bt=collections.defaultdict(lambda:[0,0])
for r in ok:
    bt[r['type']][0]+=bool(set(r['ranked'][:5])&set(r['gold'])); bt[r['type']][1]+=1
print('any@5 by type',{k:f'{a}/{b}' for k,(a,b) in bt.items()})
