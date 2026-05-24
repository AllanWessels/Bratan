import { Route, Routes, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { SetupWizard } from "./routes/SetupWizard";
import { Authoring } from "./routes/Authoring";
import { Run } from "./routes/Run";
import { Settings } from "./routes/Settings";
import { NotFound } from "./routes/NotFound";
import { ToastViewport } from "./components/Toast";
import { useSetupState } from "./api/hooks";
import { Spinner } from "./components/Spinner";

function HomeRedirect() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useSetupState();

  useEffect(() => {
    if (isLoading) return;
    if (isError || !data) {
      navigate("/setup", { replace: true });
      return;
    }
    if (data.setup_completed) {
      navigate("/authoring", { replace: true });
    } else {
      const next = Math.max(1, data.current_step ?? 1);
      navigate(`/setup/${next}`, { replace: true });
    }
  }, [data, isLoading, isError, navigate]);

  return (
    <div className="flex h-screen items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/setup/:step" element={<SetupWizard />} />
        <Route path="/authoring" element={<Authoring />} />
        <Route path="/run" element={<Run />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <ToastViewport />
    </>
  );
}
