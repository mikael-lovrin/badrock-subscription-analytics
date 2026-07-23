import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CustomerIntelligence } from "./pages/CustomerIntelligence";
import { Overview } from "./pages/Overview";
import { Products } from "./pages/Products";
import { Subscriptions } from "./pages/Subscriptions";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/products" element={<Products />} />
        <Route path="/customers" element={<CustomerIntelligence />} />
      </Routes>
    </Layout>
  );
}
