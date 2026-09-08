# Proxy Checker

Junta as listas publicas de SOCKS5, testa cada endereco e devolve so o que respondeu, ordenado.
Feito para o GoLiveBypass: e a peneira que evita cada usuario testar dezenas de milhares de enderecos
mortos na propria maquina.

## O que ele prova — e o que nao prova

Prova, para cada endereco:

1. atende TCP;
2. fala SOCKS5 **sem exigir senha** (o plugin usa proxy aberta);
3. responde **OK** ao pedido de `UDP ASSOCIATE`.

**Nao prova** que o datagrama atravessa. Isso exigiria enviar UDP, e funcao serverless da Vercel nao
envia. Uma proxy pode aceitar o ASSOCIATE e nao entregar nada — e o pior tipo, justamente porque passa
em todo teste rapido. Essa prova continua sendo do plugin, na maquina de quem usa; a diferenca e que ele
passa a fazer isso numa lista de dezenas em vez de dezenas de milhares.

## Subir na Vercel

Sem build e sem dependencia: `api/` vira funcao e `public/` vira o site.

**Pelo painel (importando este repositorio).** Na tela de *Import Project*, abra **Root Directory** e
escolha `proxy-checker`. Esse passo nao e opcional: o projeto mora numa subpasta, e apontando para a
raiz do repositorio a Vercel nao acha nem a `api/` nem a `public/` e sobe um site vazio. O resto fica
como esta — framework *Other*, sem comando de build.

**Pela linha de comando.**

```
cd proxy-checker
npx vercel deploy --prod
```

Aqui o diretorio ja e a raiz do projeto, entao nao ha o que configurar.

## Endpoints

| rota | devolve |
|---|---|
| `/` | a interface |
| `/api/proxies` | JSON com contagens, fontes e a lista ordenada |
| `/api/proxies?formato=txt` | uma por linha, `socks5://ip:porta` |
| `/api/proxies?limite=50` | corta a lista |

## Com que frequencia ele testa

A resposta vale **1 minuto** na CDN, e por mais uma hora a CDN serve a anterior enquanto revalida por
baixo (`stale-while-revalidate`). Na pratica: passado o minuto, a proxima visita recebe **na hora** a
lista da rodada anterior e a varredura nova dispara sozinha. Ninguem espera, e a lista nunca fica com
mais de um minuto de idade **enquanto houver alguem batendo** — e o plugin bate sozinho a cada 2 min.

Nao ha cron nenhum no `vercel.json`, e de proposito: o plano gratuito da Vercel aceita **no maximo um
cron por dia**, e um agendamento mais frequente que isso nao e ignorado — ele **recusa o deploy
inteiro**, com "Hobby accounts are limited to daily cron jobs". Como quem faz a lista se renovar aqui e
o trafego, o cron seria so um piso para quando nao ha ninguem acessando — e nao vale pagar o preco de o
projeto nao subir.

Se voce estiver no plano Pro e quiser esse piso, acrescente ao `vercel.json`:

```json
"crons": [{ "path": "/api/proxies", "schedule": "* * * * *" }]
```

## Ajustes por variavel de ambiente

| variavel | padrao | para que |
|---|---|---|
| `ORCAMENTO_MS` | 45000 | teto de tempo da varredura. Precisa caber no `maxDuration` da funcao |
| `PARALELO` | 300 | sondas ao mesmo tempo |
| `CONECTAR_MS` | 1200 | prazo do TCP. Curto de proposito: quase tudo na lista esta morto |
| `APERTO_MS` | 2500 | prazo do aperto de mao SOCKS5 |
| `TETO` | 40000 | quantos enderecos entram na fila depois de juntar as fontes |
| `PRAZO_FONTE_MS` | 15000 | prazo para baixar cada lista |
| `LIMITE` | 0 | corta a resposta (0 = tudo) |

O `maxDuration` esta em 60s no `vercel.json`. Se o seu plano nao permitir, baixe ele e o `ORCAMENTO_MS`
junto — o checker devolve o que deu tempo de testar e marca `completou: false`, em vez de ser cortado.

## As fontes

Sete listas publicas de SOCKS5. A do SoliSpirit (120 mil enderecos varridos em massa) **saiu**: era
quase toda endereco que nem proxy era, e o punhado que funcionava nao pagava o custo de olhar 120 mil.
No lugar entraram duas listas **curadas** — `cmahmud/proxies/alive` e `dpangestuw/Free-Proxy` — onde
quem publica ja testou antes.

O efeito e o que importa: de 119.671 enderecos unicos para **2.340**, muito mais densos. Cabe testar a
lista INTEIRA dentro do orcamento de tempo, em vez de sortear 40 mil de 120 mil e torcer.

## Testes

```
node checker-test.mjs
```

Sobe seis proxies falsas locais — uma para cada comportamento que importa (aceita UDP, recusa, exige
senha, nao e socks5, atende e cala, nao escuta) — e cobra a classificacao de cada uma, o respeito ao
orcamento de tempo, a ordenacao e a leitura dos tres formatos de lista.

## Ligar no plugin

O plugin **ja vem apontado** para `https://asdasdasd-ochre-tau.vercel.app/api/proxies`, entao quem
instala nao precisa configurar nada. Este README serve para quem quer subir o proprio.

Quando o seu estiver no ar, copie o endereco do endpoint JSON —
`https://SEU-PROJETO.vercel.app/api/proxies` — e cole em **Settings → Plugins → GoLiveBypass →
Checker URL**, ou no campo **checker site** da janela de registro, que tem os botoes *Use* e *Reset*.

Com essa URL preenchida o plugin **para de varrer as listas publicas**: passa a consumir so a lista
daqui, que ja vem peneirada, ordenada e com o pais de cada saida. E o JSON que interessa, nao o
`?formato=txt`: o texto puro nao carrega o pais, e sem ele o plugin gastaria uma conexao por proxy so
para redescobrir isso.

As listas publicas ficam de **plano B**, e so quando o checker nao devolve nada (fora do ar, varredura
vazia). Quando isso acontecer o registro do plugin diz, em vez de voltar a varrer a internet calado.

O endereco precisa ser **https** — que e o que a Vercel entrega de qualquer jeito. Nao e formalidade:
essa lista escolhe por onde a sua voz vai passar, e baixada em texto puro qualquer um no caminho (o
Wi-Fi do cafe, o roteador invadido, o provedor) pode trocar a resposta e escolher as proxies no seu
lugar. `http://` continua valendo para endereco na sua propria maquina ou na rede local, onde nao ha
caminho publico para alguem se meter; fora dai o plugin recusa e diz por que no registro.
