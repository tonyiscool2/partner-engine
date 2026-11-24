"""Population check for lead cities (default rule: target places with 10,000+ people).
Usage: python3 pop_lookup.py "City" ST [more "City" ST pairs...]
       python3 pop_lookup.py --json runs/<DATE>-candidates.json   (adds/prints city_population per row)
Data: census-places-pop.csv (Census Vintage 2024 SUB-EST: incorporated places + county subdivisions).
CDPs/unincorporated communities are not in the file -> prints UNKNOWN; verify by web search."""
import csv, json, re, sys, os
F = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'census-places-pop.csv')
AB = {'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California','CO':'Colorado','CT':'Connecticut','DE':'Delaware','DC':'District of Columbia','FL':'Florida','GA':'Georgia','HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming'}
SUF = r'\s+(city|town|village|borough|township|charter township|municipality|plantation|consolidated government.*|metropolitan government.*|unified government.*|urban county|\(balance\)).*$'
def norm(s): return re.sub(r'[^a-z0-9]', '', re.sub(SUF, '', s.lower().replace('saint ', 'st ').replace('st. ', 'st ')))
IDX = {}
for r in csv.DictReader(open(F, encoding='latin-1')):
    if r['SUMLEV'] not in ('162', '170', '061', '071', '172'): continue
    k = (r['STNAME'], norm(r['NAME']))
    p = int(r['POPESTIMATE2024'] or 0)
    if p > IDX.get(k, (0, ''))[0]: IDX[k] = (p, r['NAME'])
def pop(city, st):
    return IDX.get((AB.get(st.upper(), st), norm(city or '')), (None, None))
if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == '--json':
        rows = json.load(open(a[1]))
        for r in rows:
            p, n = pop(r.get('city'), r.get('state'))
            r['city_population'] = p
            print(f"{r['id']}\t{r.get('city')}, {r.get('state')}\t{p if p is not None else 'UNKNOWN (verify)'}\t{'OK' if p and p >= 10000 else 'UNDER 10K' if p else ''}")
        json.dump(rows, open(a[1], 'w'), indent=1)
    else:
        for c, s in zip(a[0::2], a[1::2]):
            p, n = pop(c, s); print(f"{c}, {s}\t{p if p is not None else 'UNKNOWN (verify)'}\t{n or ''}")
