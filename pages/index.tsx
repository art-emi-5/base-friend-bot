import dynamic from "next/dynamic";
import Layout from "components/Layout";

const BuySell = dynamic(() => import("components/trading/BuySell"), {
  ssr: false,
});

export default function Home() {
  return (
    <Layout>
      <div className="max-w-lg mx-auto py-5 px-4">
        <BuySell/>
      </div>
    </Layout>
  );
}
