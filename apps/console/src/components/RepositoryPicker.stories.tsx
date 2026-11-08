import type { Meta } from "@storybook/react-vite";
import { useState } from "react";
import { RepositoryPicker } from "./RepositoryPicker.tsx";
export default { title: "Account/RepositoryPicker", component: RepositoryPicker } satisfies Meta<typeof RepositoryPicker>;
function Example() {
 const [value, setValue] = useState("");
 return <div style={{ maxWidth: 740 }}>
  <RepositoryPicker value={value} disabled={false} onSource={() => {}} onSelect={repo => setValue(repo.url)} />
  <p>{value}</p>
 </div>;
}
export const Default = { render: () => <Example /> };
