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

```
cd proxy-checker
npx vercel deploy --prod
```

Sem build, sem dependencia: `api/` vira funcao e `public/` vira o site.

## Endpoints

| rota | devolve |
|---|---|
| `/` | a interface |
| `/api/proxies` | JSON com contagens, fontes e a lista ordenada |
| `/api/proxies?formato=txt` | uma por linha, `socks5://ip:porta` |
| `/api/proxies?limite=50` | corta a lista |

A resposta e cacheada na CDN por 5 min (`stale-while-revalidate` de 1h): a varredura roda raramente e
quem chega no intervalo recebe a lista anterior na hora, em vez de esperar.

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

## Testes

```
node checker-test.mjs
```

Sobe seis proxies falsas locais — uma para cada comportamento que importa (aceita UDP, recusa, exige
senha, nao e socks5, atende e cala, nao escuta) — e cobra a classificacao de cada uma, o respeito ao
orcamento de tempo, a ordenacao e a leitura dos tres formatos de lista.

## Ligar no plugin

Quando estiver no ar, o endereco `/api/proxies?formato=txt` entra como mais uma fonte no `native.ts` do
GoLiveBypass, junto das publicas — com a diferenca de que essa ja vem peneirada.
