import Card from "components/Card";
import Address from "components/Address";
import {useCallback, useEffect, useMemo, useState} from "react";
import { Input } from "components/ui/input";
import { Button } from "components/ui/button";
import { ABI, CONTRACT_ADDRESS } from "utils";
import { Global } from "state/global";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ButtonIcon, SymbolIcon } from "@radix-ui/react-icons";
import {
  readContracts,
  useAccount,
  useContractRead,
  useContractReads,
  useContractWrite,
} from "wagmi";
import {Address as AddressType} from "@wagmi/core";
import {
  BlockTag,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAbiItem,
  http,
  parseEther,
  parseGwei
} from "viem";
import Link from "next/link";
import {getTruncatedAddress} from "../../utils/getTruncatedAddress";
import { privateKeyToAccount } from "viem/accounts";
import {base} from "viem/chains";

export default function BuySell() {
  // Global state
  const {user, setUser} = Global.useContainer();

  // Local state
  const [buy, setBuy] = useState<number>(1);
  const [sell, setSell] = useState<number>(1);
  const [addresses, setAddresses] = useState<AddressType[]>([]);
  const [usedAddresses, setUsedAddresses] = useState(new Set<AddressType>());
  const [buyPrices, setBuyPrices] = useState<Record<AddressType, number>>({});
  const [bot, setBot] = useState<ReturnType<typeof privateKeyToAccount>>();
  const [blockTag, setBlockTag] = useState<bigint | BlockTag>('latest');

  const [publicClient, setPublicClient] = useState(createPublicClient({
    batch: {
      multicall: {
        wait: 16,
      },
    },
    cacheTime: 500,
    chain: base,
    transport: http()
  }));
  const [walletClient, setWalletClient] = useState(createWalletClient({
    chain: base,
    transport: http()
  }));

  // Wagmi
  const {address, isConnected} = useAccount();
  const {data: ownedAmount}: { data: BigInt | undefined } = useContractRead({
    address: CONTRACT_ADDRESS,
    abi: ABI,
    functionName: "sharesBalance",
    args: [user.address, address as AddressType],
    enabled: !!user.address && !!address,
  });
  const {data: buyPrice}: { data: BigInt | undefined } = useContractRead({
    address: CONTRACT_ADDRESS,
    abi: ABI,
    functionName: "getBuyPriceAfterFee",
    args: [user.address, BigInt(buy)],
    enabled: !!user.address,
  });
  const {data: sellPrice}: { data: BigInt | undefined } = useContractRead({
    address: CONTRACT_ADDRESS,
    abi: ABI,
    functionName: "getSellPriceAfterFee",
    args: [user.address, BigInt(sell)],
    enabled: !!user.address,
  });
  const {write: executeBuy, isLoading: buyLoading} = useContractWrite({
    address: CONTRACT_ADDRESS,
    abi: ABI,
    functionName: "buyShares",
    args: [user.address, BigInt(buy)],
    value: (buyPrice as bigint) ?? undefined,
  });
  const {write: executeSell, isLoading: sellLoading} = useContractWrite({
    address: CONTRACT_ADDRESS,
    abi: ABI,
    functionName: "sellShares",
    args: [user.address, BigInt(sell)],
  });


  const {data: feesData} = useContractReads({
    contracts: [
      {
        address: CONTRACT_ADDRESS,
        abi: ABI,
        functionName: "protocolFeePercent",
      },
      {
        address: CONTRACT_ADDRESS,
        abi: ABI,
        functionName: "subjectFeePercent",
      }
    ]
  });

  const totalFeesPercent = useMemo(() => feesData?.reduce((prev, { result }) => prev + Number(result) / 1e18, 0) ?? 0.1, [feesData]);

  const getBestPrice = useCallback((currentPriceWithFees: number) => {
    const supply = Math.sqrt(Math.ceil(currentPriceWithFees / (1 + totalFeesPercent) * 16000));
    const slidingSupply = supply < 4 ? supply + 2 : supply + 1;
    return slidingSupply ** 2 * (1 + totalFeesPercent) / 16000;
  }, [totalFeesPercent]);

  useEffect(() => {

    function onlyUnique(value, index, array) {
      return array.indexOf(value) === index;
    }

    const interval = setInterval(() => Promise.all([
        Promise.any([
            publicClient.getLogs({
              address: CONTRACT_ADDRESS,
              event: getAbiItem({
                abi: ABI,
                name: 'Trade',
              }),
              fromBlock: blockTag,
              toBlock: 'latest',
            }).then(logs => logs.map(log => decodeEventLog({ ...log, abi: ABI}).args)).
            then(trades => trades.filter(trade => trade.isBuy && trade.ethAmount === BigInt(0))).then(trades => trades.map(trade => trade.subject)),
          publicClient.getBlock<true, 'pending'>({
            blockTag: 'pending',
            includeTransactions: true,
          }).then(({ transactions }) => transactions.filter(tx => tx.to === CONTRACT_ADDRESS && tx.input.startsWith('0x6945b123') && tx.value === BigInt(0))).
          then(txs => txs.map(tx => tx.from)),
        ]).
        then(addr => setAddresses(old => [...old, ...addr].filter(onlyUnique).filter(addr => !usedAddresses.has(addr)))),
        publicClient.getBlockNumber().then((number) => setBlockTag(number)),
    ]), 1_000);

    return () => clearInterval(interval);
  }, [blockTag, publicClient, usedAddresses]);

  useEffect(() => {
    readContracts({
      contracts: addresses.map(address => ({
        address: CONTRACT_ADDRESS,
        abi: ABI,
        functionName: "getBuyPriceAfterFee",
        args: [address, BigInt(1)],
      }))
    }).then(arr => arr.map(res => res.result)).
    then(r => Object.fromEntries(r.map((v, i) => [addresses[i], Number(v) / 1e18]))).then((newObj: Record<AddressType, number>) => {
      setBuyPrices(newObj);

      if (bot) {
        const maxPriceEth = 0.012;
        const acceptableFollowers = 200000;
        const minFollowers = 10000;
        const acceptableScore = 90;
        const minScore = 30;

        const entries = Object.entries(newObj) as [AddressType, number][];
        const acceptableValues = entries.map(([addr, val]) => [addr, getBestPrice(val)] as const)
            .filter(([, val]) => val <= maxPriceEth).sort(([, v1], [, v2]) => v1 - v2);

        if (acceptableValues.length > 0) {
          publicClient.getTransactionCount(bot).then(nonce => Promise.all(acceptableValues.map(([address, price]) =>
              fetch(`https://prod-api.kosetto.com/users/${address}`).
              then(res => res.json()).then(res => res.twitterUsername).
              then(username => fetch(`https://corsproxy.io/?${encodeURIComponent(`https://twitterscore.io/twitter/graph/ajax/?accountSlug=${username}`)}`).
              then(res => res.ok ?
                  res.json().then(res => res.followers.length > 0 ? [res.followers[res.followers.length - 1]?.value ?? 0, res.scores[res.scores.length - 1]?.value ?? 0, true] : [0, 0, true]) :
                  fetch(`https://api.socialcounts.org/twitter-live-follower-count/${username}`).then(res => res.ok ? res.json() : { API_sub: 0, est_sub: 0 }).then(res => [res.API_sub, res.est_sub, false], () => [0, 0, false])
              ).then(res => [address, price, ...res, username] as const)))).
              then((tmp) => { console.log(tmp.map(val => ({ address: val[0], price: val[1], followers: val[2], score: val[3], isScoreReal: val[4], username: val[5] }))); return tmp; }). // debug
              then(res => res.filter(([,,followers, score, isReal]) => (followers >= acceptableFollowers) || (followers >= minFollowers && score >= minScore) || (isReal && score >= acceptableScore)).
          map(([address, value], index) => publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: ABI,
            functionName: "getBuyPriceAfterFee",
            args: [address, BigInt(1)],
          }).then(newPrice => getBestPrice(Number(newPrice) / 1e18), () => value).
          then(newPrice => { console.log({ oldPrice: value, newPrice }); return newPrice; }).
          then(newPrice => newPrice <= maxPriceEth ? walletClient.writeContract({
            address: CONTRACT_ADDRESS,
            abi: ABI,
            functionName: 'buyShares',
            args: [address, BigInt(1)],
            account: bot,
            maxFeePerGas: parseGwei('50'),
            maxPriorityFeePerGas: parseGwei('20'),
            value: parseEther(newPrice + ''),
            gas: BigInt(100000),
            nonce: nonce + index,
          }) : undefined).then(hash => hash ? publicClient.waitForTransactionReceipt({ hash }).then(
              res => console.log(res),
              () => setUsedAddresses(old => new Set([...old].filter(a => a !== address))),
              ) : undefined, e => console.error(e),
          ))));

          setUsedAddresses(old => new Set([...old, ...acceptableValues.map(([addr,]) => addr)]));
        }
      }

    });
  }, [addresses, bot, publicClient, getBestPrice, walletClient]);

  useEffect(() => usedAddresses.size > 20 ? setUsedAddresses(new Set()) : undefined, [usedAddresses]);

  // Reset on user change
  useEffect(() => {
    setBuy(1);
    setSell(1);

    setPublicClient(createPublicClient({
      batch: {
        multicall: {
          wait: 16,
        },
      },
      cacheTime: 500,
      chain: base,
      transport: http()
    }));
    setWalletClient(createWalletClient({
      chain: base,
      transport: http()
    }));
  }, [user]);

  const handleSearch = (e) => {
    setUser({
      address: e.target.elements.address.value,
      username: "",
      image: ""
    })
  }

  const handleBotLoad = (e) => {
    const privateKeyValue = e.target.elements.privateKey.value;
    const privateKey = (privateKeyValue as string).startsWith('0x') ? privateKeyValue : '0x' + privateKeyValue;
    setBot(privateKeyToAccount(privateKey));
    e.preventDefault();
  }

  return (
    <>
      <form onSubmit={handleSearch} className="flex max-sm:flex-wrap items-center gap-1 mb-4">
        <Input name="address" defaultValue={user.address} className="text-base h-12"/>
        <Button className="h-12 max-sm:w-full" type="submit">Search</Button>
      </form>
      <form onSubmit={handleBotLoad} className="flex max-sm:flex-wrap items-center gap-1 mb-4">
        <Input name="privateKey" type="password" placeholder="Insert the bot's private key here" className="text-base h-12"/>
        <Button className="h-12 max-sm:w-full" type="submit">Load</Button>
      </form>

      {!!bot && <Card title="Bot"><div className="p-2">
        <span>Bot is active ({bot.address})</span>
        <Button className="mt-2 w-full bg-sell hover:bg-sell hover:opacity-70" type="button" onClick={() => setBot(undefined)}>Disable</Button>
      </div></Card>}

      <Card title="Buy/Sell">
        <div className="h-full p-4">
          {!isConnected ? (
            // Not connected state
            <div
              className="flex flex-col items-center justify-center h-full border border-dashed rounded-md">
              <ButtonIcon className="w-12 h-12 text-zinc-500"/>
              <span className="text-zinc-500">Connect wallet to trade</span>
              <div className="mt-4">
                <ConnectButton/>
              </div>
            </div>
          ) : (
            <div className="flex flex-col h-full gap-3">
              <div>
              <span className="flex flex-wrap gap-2 break-word text-sm items-center">
                You own {Number(ownedAmount ?? 0)} share(s) of{" "}
                <span>
                  <Address
                    address={user.address}
                    username={user.username}
                    image={user.image}
                  />
                </span>
              </span>
              </div>

              {/* Buy shares */}
              <Card title="Buy shares">
                <div className="p-2">
                  <Input value={buy} disabled/>

                  <div className="flex [&>button]:flex-1 gap-3 mt-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (buy > 0) setBuy((previous) => previous - 1);
                      }}
                      disabled={buy === 0}
                    >
                      -
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setBuy((previous) => previous + 1)}
                    >
                      +
                    </Button>
                  </div>

                  <Button
                    className="mt-2 w-full bg-buy hover:bg-buy hover:opacity-70"
                    onClick={() => executeBuy()}
                    disabled={buy === 0 || buyLoading}
                  >
                    {buyLoading ? (
                      <div className="flex items-center">
                        <SymbolIcon className="h-4 w-4 animate-spin"/>
                        <span className="pr-2">Executing buy...</span>
                      </div>
                    ) : (
                      <span>
                      Buy {buy} share(s){" "}
                        {buyPrice
                          ? `for ${(Number(buyPrice) / 1e18).toFixed(6)} Ξ`
                          : ""}
                    </span>
                    )}
                  </Button>
                </div>
              </Card>

              {/* Sell shares */}
              <Card title="Sell shares">
                <div className="p-2">
                  <Input value={sell} disabled/>

                  <div className="flex [&>button]:flex-1 gap-3 mt-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (sell > 0) setSell((previous) => previous - 1);
                      }}
                      disabled={sell === 0}
                    >
                      -
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSell((previous) => previous + 1);
                        // if (sell < Number(ownedAmount ?? 0)) {
                        //   setSell((previous) => previous + 1);
                        // }
                      }}
                      // disabled={sell >= Number(ownedAmount ?? 0)}
                    >
                      +
                    </Button>
                  </div>

                  <Button
                    className="mt-2 w-full bg-sell hover:bg-sell hover:opacity-70"
                    onClick={() => executeSell()}
                    disabled={sell === 0 || sellLoading}
                  >
                    {sellLoading ? (
                      <div className="flex items-center">
                        <SymbolIcon className="h-4 w-4 animate-spin"/>
                        <span className="pr-2">Executing sell...</span>
                      </div>
                    ) : (
                      <span>
                      Sell {sell} share(s){" "}
                        {sellPrice
                          ? `
    for ${(Number(sellPrice) / 1e18).toFixed(6)} Ξ`
                          :
                          ""
                        }
  </span>
                    )
                    }
                  </Button>
                </div>
              </Card>
            </div>
          )
          }
        </div>
      </Card>
      {/* Suggestions */}
      <Card title="Suggested addresses">
        <div className="p-2 flex flex-col gap-2 max-h-[20vh]">
          {addresses.map(a => <Link key={a} onClick={() => setUser({ address: a })} href={`/?address=${a}`}>{`${getTruncatedAddress(a)} for ${buyPrices[a]?.toFixed(6) ?? '???'} Ξ`}</Link>)}
        </div>
      </Card>
    </>
  )
    ;
}
