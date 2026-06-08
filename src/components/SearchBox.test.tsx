import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SearchBox } from './SearchBox'

function SearchBoxHarness(props: { onSearch(query: string): void }) {
  const [query, setQuery] = useState('')
  return <SearchBox query={query} onQueryChange={setQuery} onSearch={props.onSearch} />
}

describe('SearchBox', () => {
  it('submits search query', () => {
    const onSearch = vi.fn()
    render(<SearchBoxHarness onSearch={onSearch} />)
    const input = screen.getByLabelText('搜索历史输出')
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(onSearch).toHaveBeenCalledWith('needle')
  })
})
