// GET /api/proxies
//
// Devolve as proxies que passaram, ordenadas. Formatos:
//   /api/proxies             -> JSON com metadados. E o que a interface usa, e tambem o que o plugin
//                               le: so aqui vai o pais de cada saida, e sem ele o plugin gastaria uma
//                               conexao por proxy para redescobrir isso
//   /api/proxies?formato=txt -> uma por linha, "socks5://ip:porta", para colar em outra ferramenta
//   /api/proxies?limite=50   -> corta a lista
//
// A conta cara e feita UMA vez e servida do cache da CDN. Sem isso, cada visita a pagina dispararia
// uma varredura de dezenas de milhares de enderecos -- o que, alem de lento, viraria um pequeno ataque
// contra as listas publicas.
import { juntarFontes, checar, ranquear } from "./_checker.js";

// De onde saem os numeros: da variavel de ambiente quando houver, senao de um padrao conservador que
// cabe no tempo de funcao do plano gratuito.
const numero = (nome, padrao) => {
    const bruto = Number(process.env[nome]);
    return Number.isFinite(bruto) && bruto > 0 ? bruto : padrao;
};

export default async function handler(req, res) {
    const url = new URL(req.url, "http://local");
    const formato = url.searchParams.get("formato") ?? "json";
    const limite = numero("LIMITE", 0) || Number(url.searchParams.get("limite")) || 0;

    try {
        const comecou = Date.now();

        const { enderecos, paises, origem, resumo, totalUnico } = await juntarFontes({
            prazoFonte: numero("PRAZO_FONTE_MS", 15_000),
            teto: numero("TETO", 40_000)
        });

        const { aprovadas, contagem, completou } = await checar(enderecos, {
            paralelo: numero("PARALELO", 300),
            orcamentoMs: numero("ORCAMENTO_MS", 45_000),
            conectarMs: numero("CONECTAR_MS", 1200),
            aperoMs: numero("APERTO_MS", 2500)
        });

        const ranque = ranquear(aprovadas, paises, origem);
        const lista = limite > 0 ? ranque.slice(0, limite) : ranque;

        // UM minuto de validade, e uma hora servindo o antigo enquanto revalida.
        //
        // E assim que "checar a cada minuto" acontece sem depender de plano pago: passado o minuto, a
        // proxima visita recebe NA HORA a lista da rodada anterior e a CDN dispara a nova varredura por
        // baixo. Ninguem espera, e a lista nunca tem mais de um minuto de idade enquanto houver alguem
        // (o plugin inclusive) batendo aqui.
        //
        // E por isto que nao ha cron: o plano gratuito da Vercel aceita no maximo um por dia, e um
        // agendamento mais frequente RECUSA O DEPLOY inteiro em vez de ser ignorado. O cron seria so um
        // piso para quando nao ha ninguem acessando -- nao vale o projeto nao subir.
        res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=3600");
        res.setHeader("access-control-allow-origin", "*");

        if (formato === "txt") {
            res.setHeader("content-type", "text/plain; charset=utf-8");
            return res.status(200).send(lista.map(p => p.proxy).join("\n"));
        }

        res.setHeader("content-type", "application/json; charset=utf-8");
        return res.status(200).json({
            geradoEm: new Date().toISOString(),
            levouMs: Date.now() - comecou,
            // "completou" falso quer dizer que o orcamento de tempo acabou antes da lista. Nao e erro:
            // e o que deu para testar nesta rodada, e esta dito em vez de escondido.
            completou,
            candidatas: enderecos.length,
            totalUnicoNasFontes: totalUnico,
            ...contagem,
            fontes: resumo,
            // O que este checker NAO prova, dito no proprio corpo da resposta para nao virar
            // mal-entendido: a Vercel nao envia UDP, entao "udp" aqui quer dizer que a proxy ACEITOU o
            // pedido de ASSOCIATE, nao que o datagrama atravessa. Essa ultima prova e do plugin.
            aviso: "udp = a proxy aceitou UDP ASSOCIATE. Se o datagrama realmente atravessa, so o cliente consegue provar.",
            proxies: lista
        });
    } catch (erro) {
        res.setHeader("cache-control", "no-store");
        return res.status(500).json({ erro: erro instanceof Error ? erro.message : String(erro) });
    }
}
