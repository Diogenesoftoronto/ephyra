import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataTable } from "./DataTable.tsx";

const meta: Meta = { title: "Components/DataTable" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <DataTable label="Example costs">
      <thead>
        <tr>
          <th>Work</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Research</td>
          <td>Unknown</td>
        </tr>
      </tbody>
    </DataTable>
  ),
};
